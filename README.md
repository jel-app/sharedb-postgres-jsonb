# Note

Move to [@plotdb/sharedb-postgres](https://github.com/plotdb/sharedb-postgres). Don't use this repo unless for compatibility reason.

# sharedb-postgres

PostgreSQL database adapter for [sharedb](https://github.com/share/sharedb). This
driver can be used both as a snapshot store and oplog.

Doesn't support queries (yet?).

Moderately experimental. (This drives [Synaptograph](https://www.synaptograph.com)'s backend, and [@nornagon](https://github.com/nornagon) hasn't noticed any issues so far.)


## Requirements

Due to the fix to resolve [high concurency issues](https://github.com/share/sharedb-postgres/issues/1) Postgres 9.5+ is now required.

## Migrating older versions

Older versions of this adaptor used the data type json. You will need to alter the data type prior to using if you are upgrading. 

```PLpgSQL
ALTER TABLE ops
  ALTER COLUMN operation
  SET DATA TYPE jsonb
  USING operation::jsonb;

ALTER TABLE snapshots
  ALTER COLUMN data
  SET DATA TYPE jsonb
  USING data::jsonb;
```

## Usage

`sharedb-postgres-jsonb` wraps native [node-postgres](https://github.com/brianc/node-postgres), and it supports the same configuration options.

To instantiate a sharedb-postgres wrapper, invoke the module and pass in your
PostgreSQL configuration as an argument or use environmental arguments. 

For example using environmental arugments:

```js
var db = require('sharedb-postgres')();
var backend = require('sharedb')({db: db})
```

Then executing via the command line 

```
PGUSER=dbuser  PGPASSWORD=secretpassword PGHOST=database.server.com PGDATABASE=mydb PGPORT=5433 npm start
```

Example using an object

```js
var db = require('sharedb-postgres')({host: 'localhost', database: 'mydb'});
var backend = require('sharedb')({db: db})
```

## Error codes

PostgreSQL errors are passed back directly.

## Changelog

Note that version 3.0.0 introduces breaking changes in how you specify
connection parameters. See the [changelog](CHANGELOG.md) for more info.
