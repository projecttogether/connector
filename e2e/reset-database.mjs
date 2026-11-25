// Creates an empty connector_e2e database on the PostgreSQL of compose.dev.yaml.
import pg from "pg";

const client = new pg.Client({ connectionString: "postgres://connector:connector@localhost:55452/postgres" });
await client.connect();
await client.query("drop database if exists connector_e2e with (force)");
await client.query("create database connector_e2e");
await client.end();
