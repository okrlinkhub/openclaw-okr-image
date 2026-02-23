# openclaw-okr-image

Worker image for `agent-factory` on Fly Machines.

## Publish on a dedicated Fly app

Use a dedicated Fly app for each Convex backend/environment.

```sh
# 1) Create the app once (pick org/region as needed)
fly apps create agent-factory-workers-linkhub-w4 --org personal

# 2) Set required runtime secrets
fly secrets set CONVEX_URL="https://<your-deployment>.convex.cloud" -a agent-factory-workers-linkhub-w4
fly secrets set MOONSHOT_API_KEY="<...>" -a agent-factory-workers-linkhub-w4
# optional fallback
fly secrets set OPENAI_API_KEY="<...>" -a agent-factory-workers-linkhub-w4

# 3) Deploy image with remote builder
fly deploy --remote-only --depot=false --yes
```

After deploy, copy the printed image tag and use it in your Convex consumer app:

```ts
const providerConfig = {
  kind: "fly" as const,
  appName: "agent-factory-workers-linkhub-w4",
  image: "registry.fly.io/agent-factory-workers-linkhub-w4:deployment-XXXXXXXXXXXX",
  // ...
};
```

## Why dedicated apps

If two different Convex backends share the same Fly app, both control loops can list/stop/spawn
the same machine pool and queue polling becomes nondeterministic across backends.
