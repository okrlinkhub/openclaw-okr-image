---
name: linkhub-bridge
version: 1.0.0
description: Recupera contesto OKR da LinkHub tramite Agent Bridge
tools:
  - name: fetch_okr_context
    description: Ottieni contesto utente da LinkHub W4
    parameters:
      userId: string
      message: string
---

# LinkHub Bridge Skill

Questa skill usa lo script `scripts/fetch_context.js` per chiamare
`/agent/execute` del bridge Convex host-side e restituire JSON su stdout.
