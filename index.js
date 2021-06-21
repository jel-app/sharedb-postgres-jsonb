const DB = require('sharedb').DB;
const pg = require('pg');

// Cache of snapshots to return, to avoid fetch I/O
const snapshotCache = new Map();

// setTimeouts for flushing
const flushTimeouts = new Map();
const flushRetryTimeouts = new Map();

const pendingSnapshotFlushValues = new Map();
const flushingSymbol = "flushing";

const WRITE_FLUSH_DELAY = 500;
const RETRY_FLUSH_DELAY = 5000;
const MAX_CACHED_SNAPSHOTS = 128;

/*
* This query uses common table expression to upsert the snapshot table 
* (iff the new version is exactly 1 more than the latest table or if
* the document id does not exists)
*
* It will then insert into the ops table if it is exactly 1 more than the 
* latest table or it the first operation and iff the previous insert into
* the snapshot table is successful.
*
* This result of this query the version of the newly inserted operation
* If either the ops or the snapshot insert fails then 0 rows are returned
*
* If 0 zeros are return then the callback must return false   
*
* Casting is required as postgres thinks that collection and doc_id are
* not varchar  
*/  
const SNAPSHOT_INSERT_DATA_SQL = `WITH snapshot_id AS (
  INSERT INTO snapshots (collection, doc_id, doc_type, version, data)
  SELECT $1::varchar collection, $2::varchar doc_id, $4 doc_type, $3 v, $5 d
  WHERE $3 = (
    SELECT version+1 v
    FROM snapshots
    WHERE collection = $1 AND doc_id = $2
    FOR UPDATE
  ) OR NOT EXISTS (
    SELECT 1
    FROM snapshots
    WHERE collection = $1 AND doc_id = $2
    FOR UPDATE
  )
  ON CONFLICT (collection, doc_id) DO UPDATE SET version = $3, data = $5, doc_type = $4
  RETURNING version
)
INSERT INTO ops (collection, doc_id, version, operation)
SELECT $1::varchar collection, $2::varchar doc_id, $3 v, $6 operation
WHERE (
  $3 = (
    SELECT max(version)+1
    FROM ops
    WHERE collection = $1 AND doc_id = $2
  ) OR NOT EXISTS (
    SELECT 1
    FROM ops
    WHERE collection = $1 AND doc_id = $2
  )
) AND EXISTS (SELECT 1 FROM snapshot_id)
RETURNING version`;

// This query does the same but skips updating the data to reduce I/O.
const SNAPSHOT_SKIP_DATA_SQL = `WITH snapshot_id AS (
  INSERT INTO snapshots (collection, doc_id, doc_type, version, data)
  SELECT $1::varchar collection, $2::varchar doc_id, $4 doc_type, $3 v, $5 d
  WHERE $3 = (
    SELECT version+1 v
    FROM snapshots
    WHERE collection = $1 AND doc_id = $2
    FOR UPDATE
  ) OR NOT EXISTS (
    SELECT 1
    FROM snapshots
    WHERE collection = $1 AND doc_id = $2
    FOR UPDATE
  )
  ON CONFLICT (collection, doc_id) DO UPDATE SET version = $3, doc_type = $4
  RETURNING version
)
INSERT INTO ops (collection, doc_id, version, operation)
SELECT $1::varchar collection, $2::varchar doc_id, $3 v, $6 operation
WHERE (
  $3 = (
    SELECT max(version)+1
    FROM ops
    WHERE collection = $1 AND doc_id = $2
  ) OR NOT EXISTS (
    SELECT 1
    FROM ops
    WHERE collection = $1 AND doc_id = $2
  )
) AND EXISTS (SELECT 1 FROM snapshot_id)
RETURNING version`;

// Postgres-backed ShareDB database

function PostgresDB(options) {
  if (!(this instanceof PostgresDB)) return new PostgresDB(options);
  DB.call(this, options);

  this.closed = false;
  this.disableFlushRetries = false;

  this.pg_config = options;
  this.pool = new pg.Pool(options);
};
module.exports = PostgresDB;

PostgresDB.prototype = Object.create(DB.prototype);

PostgresDB.prototype.close = function(callback) {
  this.closed = true;
  this.pool.end();
  
  if (callback) callback();
};


// Persists an op and snapshot if it is for the next version. Calls back with
// callback(err, succeeded)
PostgresDB.prototype.commit = function(collection, id, op, snapshot, options, callback) {
  const cacheKey = `${collection}_${id}`;
  let pendingValues = pendingSnapshotFlushValues.get(cacheKey);

  if (!pendingValues) {
    pendingValues = [];
    pendingSnapshotFlushValues.set(cacheKey, pendingValues);
  }

  for (let i = 0; i < pendingValues.length; i++) {
    // Skip writing the data for all the previous pending values.
    pendingValues[i][4] = null;
  }

  pendingValues.push([collection,id,snapshot.v, snapshot.type, snapshot.data, op])

  const timeout = flushTimeouts.get(cacheKey);

  // If a flush is enqueued, delay it.
  if (timeout && timeout !== flushingSymbol) {
    clearTimeout(timeout);
  }

  // If a flush is not currently running, enqueue it.
  if (timeout !== flushingSymbol) {
    const flush = async () => {
      // When timeout is hit, mark this key as flushing
      flushTimeouts.set(cacheKey, flushingSymbol);

      if (!pendingSnapshotFlushValues.has(cacheKey)) return;

      const pendingValues = pendingSnapshotFlushValues.get(cacheKey);

      /*
       * op: CreateOp {
       *   src: '24545654654646',
       *   seq: 1,
       *   v: 0,
       *   create: { type: 'http://sharejs.org/types/JSONv0', data: { ... } },
       *   m: { ts: 12333456456 } }
       * }
       * snapshot: PostgresSnapshot
       */
      await new Promise(flushRes => {
        this.pool.connect(async (err, client, done) => {
          if (err) {
            done(client);
            flushRes();
            return;
          }

          let failed = false;

          // Flush all pending writes.
          while (pendingValues.length > 0 && !failed) {
            const values = pendingValues[0];

            let query;

            const hasData = values[4] !== null;

            if (hasData) {
              query = {
                name: 'sdb-commit-op-and-snap',
                text: SNAPSHOT_INSERT_DATA_SQL,
                values
              };
            } else {
              // Skip the data for an intermediate version update, to reduce
              // I/O and ensure consistency.
              //
              // This is safe to do since the version is served up by the 
              // snapshot cache.
              query = {
                name: 'sdb-commit-op-and-snap-skip-data',
                text: SNAPSHOT_SKIP_DATA_SQL,
                values: [values[0], values[1], values[2], values[3], {}, values[5]]
              };
            }

            if (!failed) {
              await new Promise(r => {
                client.query(query, (err, res) => {
                  if (err) {
                    failed = true;
                  } else {
                    // Dequeue write
                    pendingValues.shift();
                  }
                  r();
                });
              });
            }
          }

          if (!failed) {
            done(client);
          } else if (!this.disableFlushRetries) {
            const retryTimeout = flushRetryTimeouts.get(cacheKey);

            if (retryTimeout) {
              clearTimeout(retryTimeout);
            }

            // Retry in case of error
            flushRetryTimeouts.set(cacheKey, setTimeout(() => {
              if (!flushTimeouts.has(cacheKey)) {
                flush();
              }
            }, RETRY_FLUSH_DELAY));
          }

          flushRes();
        })
      });

      flushTimeouts.delete(cacheKey);

      if (pendingValues.length === 0) {
        pendingSnapshotFlushValues.delete(cacheKey);
      }
    };

    flushTimeouts.set(cacheKey, setTimeout(flush, WRITE_FLUSH_DELAY));
  }

  // NOTE: we optimistically confirm the commit here. This will cause clients to
  // start breaking if the commits are not actually landed during an outage
  // that doesn't gracefully shutdown the server since the client's version
  // will be ahead of what is in the database.
  //
  // This will need to be fixed eventually when adding better fault tolerance
  // but is necessary to ensure low latency and not slapping the db with I/O.
  callback(null, snapshotCache.has(cacheKey));
};

// Get the named document from the database. The callback is called with (err,
// snapshot). A snapshot with a version of zero is returned if the docuemnt
// has never been created in the database.
PostgresDB.prototype.getSnapshot = function(collection, id, fields, options, callback) {

  // Use this opportunity to clean the snapshot cache.
  //
  // Don't clear it if there are pending flushes since that can cause consistency
  // problems.
  if (snapshotCache.size >= MAX_CACHED_SNAPSHOTS && !this.hasPendingFlush()) {
    snapshotCache.clear();
  }

  const cacheKey = `${collection}_${id}`;
  const snapshot = snapshotCache.get(cacheKey);

  // NOTE: we return the snapshot as-is here to avoid additional I/O.
  // This is less correct, and presumes that the server is a singleton.
  if (snapshot) {
    callback(null, snapshot);
    return;
  }

  this.pool.connect(function(err, client, done) {
    if (err) {
      done(client);
      callback(err);
      return;
    }
    client.query(
      'SELECT version, data, doc_type FROM snapshots WHERE collection = $1 AND doc_id = $2 LIMIT 1',
      [collection, id],
      function(err, res) {
        done(client);
        if (err) {
          callback(err);
          return;
        }
        if (res.rows.length) {
          const row = res.rows[0]
          const snapshot = new PostgresSnapshot(
            id,
            row.version,
            row.doc_type,
            row.data,
            undefined // TODO: metadata
          )
          snapshotCache.set(cacheKey, snapshot);
          callback(null, snapshot);
        } else {
          const snapshot = new PostgresSnapshot(
            id,
            0,
            null,
            undefined,
            undefined
          )
          snapshotCache.set(cacheKey, snapshot);
          callback(null, snapshot);
        }
      }
    )
  })
};

// Get operations between [from, to) noninclusively. (Ie, the range should
// contain start but not end).
//
// If end is null, this function should return all operations from start onwards.
//
// The operations that getOps returns don't need to have a version: field.
// The version will be inferred from the parameters if it is missing.
//
// Callback should be called as callback(error, [list of ops]);
PostgresDB.prototype.getOps = function(collection, id, from, to, options, callback) {
  this.pool.connect(function(err, client, done) {
    if (err) {
      done(client);
      callback(err);
      return;
    }

    var cmd = 'SELECT version, operation FROM ops WHERE collection = $1 AND doc_id = $2 AND version > $3 ';
    var params = [collection, id, from];
    if(to || to == 0) { cmd += ' AND version <= $4'; params.push(to)}
    cmd += ' order by version';
    client.query( cmd, params,
      function(err, res) {
        done(client);
        if (err) {
          callback(err);
          return;
        }
        callback(null, res.rows.map(function(row) {
          return row.operation;
        }));
      }
    )
  })
};

PostgresDB.prototype.hasPendingFlush = function() {
  return pendingSnapshotFlushValues.size > 0;
};

PostgresDB.prototype.purgeOldOps = function() {
  this.pool.connect(function(err, client, done) {
    if (err) {
      done(client);
      return;
    }

    // Keep the last 10 ops for a given doc
    const cmd = `
      DELETE
      FROM ops op1
      WHERE op1.inserted_at < now() - interval '12 hours'
      AND op1.inserted_at NOT IN (SELECT inserted_at
                       FROM ops op2
                       WHERE op1.collection = op2.collection AND op1.doc_id = op2.doc_id
                       ORDER BY op2.inserted_at DESC
                       LIMIT 10)`;

    client.query( cmd, [], () => done(client));
  })
};

function PostgresSnapshot(id, version, type, data, meta) {
  this.id = id;
  this.v = version;
  this.type = type;
  this.data = data;
  this.m = meta;
}
