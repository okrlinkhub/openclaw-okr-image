---
name: agent-bridge
description: Client per Agent Bridge v3.0.2 - Execute-on-Behalf con mappa multi-app.
---

# Agent Bridge v3.0.2 (Execute-on-Behalf Multi-App)

Client per il nuovo flusso **execute-on-behalf** con supporto multi-app tramite mappa JSON.

## 🎯 Novità: APP_BASE_URL_MAP_JSON

Invece di una singola `APP_BASE_URL`, ora si usa una **mappa JSON** che associa ogni `appKey` al suo base URL:

```json
{
  "linkhub": "https://www.okrlink.app",
  "linkhub-w4": "https://www.okrlink.app",
  "example": "https://woozy-retriever-951.convex.site",
  "amc": "https://amc-primogroup.convex.site"
}
```

### Vantaggi:
- ✅ **Multi-app**: Una sola istanza OpenClaw gestisce multiple app
- ✅ **Routing dinamico**: URL risolto in base all'`appKey`
- ✅ **Flessibilità**: Facile aggiungere nuove app

## 🔄 Flusso Completo

```
┌──────────────┐     ┌─────────────────────────┐     ┌─────────────────┐
│   OpenClaw   │────→│  App BFF                │────→│  Agent Bridge   │
│              │     │  (es. www.okrlink.app)  │     │   (Convex)      │
└──────────────┘     └─────────────────────────┘     └─────────────────┘
                            │
                            │ Resolve appKey da APP_BASE_URL_MAP_JSON
                            │ Chiama /api/agent/execute-on-behalf
```

## 🔧 Variabili d'Ambiente

| Variabile | Richiesta | Descrizione |
|-----------|-----------|-------------|
| `APP_BASE_URL_MAP_JSON` | ✅ | Mappa JSON `appKey -> baseUrl` |
| `OPENCLAW_SERVICE_ID` | ✅ | Service ID (es. `openclaw-prod`) |
| `OPENCLAW_SERVICE_KEY` | ✅ | Service Key (`abs_live_...`) |
| `AGENT_BRIDGE_DEFAULT_APP_KEY` | ⚠️ | App di default (fallback) |

### Esempio Configurazione

```bash
# Railway Environment Variables
APP_BASE_URL_MAP_JSON='{
  "linkhub": "https://www.okrlink.app",
  "linkhub-w4": "https://www.okrlink.app",
  "example": "https://woozy-retriever-951.convex.site"
}'
OPENCLAW_SERVICE_ID="openclaw-prod"
OPENCLAW_SERVICE_KEY="abs_live_xxxxxxxx"
AGENT_BRIDGE_DEFAULT_APP_KEY="linkhub"
```

## 📡 Endpoint

### `POST {resolved_base_url}/api/agent/execute-on-behalf`

L'URL base viene **risolto dinamicamente** dalla mappa in base all'`appKey`.

**Esempio:**
- `appKey: "linkhub"` → `https://www.okrlink.app/api/agent/execute-on-behalf`
- `appKey: "example"` → `https://woozy-retriever-951.convex.site/api/agent/execute-on-behalf`

**Headers:**
```http
Content-Type: application/json
X-Agent-Service-Id: openclaw-prod
X-Agent-Service-Key: abs_live_xxxxxxxx
```

**Body:**
```json
{
  "functionKey": "initiatives.getAllForCurrentUser",
  "provider": "discord",
  "providerUserId": "947270381897662534",
  "appKey": "linkhub",
  "args": {}
}
```

## 🚀 Uso Multi-App

### Scenario: Gestire Linkhub + AMC

**1. Configura la mappa:**
```json
{
  "linkhub": "https://www.okrlink.app",
  "amc": "https://amc-primogroup.convex.site"
}
```

**2. Chiamata a Linkhub:**
```python
execute_on_behalf(
    function_key="initiatives.getAllForCurrentUser",
    provider="discord",
    provider_user_id="123...",
    app_key="linkhub"  # → Risolto a https://www.okrlink.app
)
```

**3. Chiamata a AMC:**
```python
execute_on_behalf(
    function_key="patients.getList",
    provider="discord", 
    provider_user_id="123...",
    app_key="amc"  # → Risolto a https://amc-primogroup.convex.site
)
```

## 🛡️ Error Handling

| Status | Errore | Azione |
|--------|--------|--------|
| `400` | Payload/header mancanti | Verifica request |
| `401` | Service credentials non valide | Controlla env vars |
| `403` | `delegation_denied` | Permessi insufficienti |
| `404` | `link_not_found` | Suggerisci `/link {app}` |
| `410` | `link_revoked` / `link_expired` | Suggerisci relink |
| `429` | Rate limit | Attendi `Retry-After` |

## 📝 Comandi

```bash
# Verifica stato
agent-bridge status

# Esegui su app specifica
agent-bridge execute "initiatives.getAllForCurrentUser" --app-key linkhub
```

## 🔗 Migrazione da APP_BASE_URL singola

Prima:
```bash
APP_BASE_URL=https://www.okrlink.app  # Una sola app
```

Dopo:
```bash
APP_BASE_URL_MAP_JSON='{"linkhub":"https://www.okrlink.app","example":"..."}'  # Multi-app
```

Nota operativa: questa skill in immagine è configurata in modalità strict.
Se `APP_BASE_URL_MAP_JSON` manca o non contiene l'`appKey` richiesta, la chiamata fallisce esplicitamente.