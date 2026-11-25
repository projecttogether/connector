# End-to-end tests

A real browser against the built app, signing in through Keycloak.

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL, Keycloak
npm run build
npx playwright install chromium            # once
npm run test:e2e
```

The app runs on port 3000 with a fresh database (`connector_e2e`),
`ADMIN_EMAILS=ada@example.org`, `ACCESS_GROUPS=/staff` and
`DIRECTORY=keycloak`. The test users are listed in `compose.dev.yaml`. The
tests send signed Logbook webhooks to the app.
