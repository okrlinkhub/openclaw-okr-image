#!/usr/bin/env python3
"""
Agent Bridge Client v3.0.2 - Execute-on-Behalf Mode
Skill per OpenClaw

Novo flusso: OpenClaw → App BFF (execute-on-behalf) → Agent Bridge
"""

import os
import sys
import json
import urllib.request
import urllib.error

def get_service_id():
    """Ottieni service ID dalle variabili d'ambiente"""
    service_id = os.getenv('OPENCLAW_SERVICE_ID')
    
    if not service_id:
        print("❌ OPENCLAW_SERVICE_ID non trovato")
        print("   Imposta: export OPENCLAW_SERVICE_ID='openclaw-prod'")
        return None
    
    return service_id

def get_service_key():
    """Ottieni service key dalle variabili d'ambiente"""
    service_key = os.getenv('OPENCLAW_SERVICE_KEY')
    
    if not service_key:
        print("❌ OPENCLAW_SERVICE_KEY non trovato")
        print("   Imposta: export OPENCLAW_SERVICE_KEY='abs_live_...'")
        return None
    
    return service_key

def load_app_base_url_map():
    """Carica mappa appKey -> baseUrl da APP_BASE_URL_MAP_JSON"""
    map_json = os.getenv('APP_BASE_URL_MAP_JSON', '').strip()
    if not map_json:
        print("❌ APP_BASE_URL_MAP_JSON non trovato")
        print("   Imposta: export APP_BASE_URL_MAP_JSON='{\"linkhub-w4\":\"https://www.okrlink.app\"}'")
        return None
    try:
        parsed = json.loads(map_json)
    except json.JSONDecodeError:
        print("❌ APP_BASE_URL_MAP_JSON non valido (JSON parsing error)")
        return None

    if not isinstance(parsed, dict) or len(parsed) == 0:
        print("❌ APP_BASE_URL_MAP_JSON deve essere un oggetto JSON non vuoto")
        return None

    normalized = {}
    for key, value in parsed.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        app_key = key.strip()
        base_url = ensure_https(value.strip())
        if app_key and base_url:
            normalized[app_key] = base_url.rstrip("/")

    if not normalized:
        print("❌ APP_BASE_URL_MAP_JSON non contiene coppie appKey/baseUrl valide")
        return None

    return normalized

def ensure_https(url):
    """Assicura che l'URL inizi con https://"""
    if url and not url.startswith('http://') and not url.startswith('https://'):
        return f"https://{url}"
    return url

def get_app_base_url(app_key=None):
    """Ottieni base URL dell'app consumer dalla mappa JSON"""
    # Carica mappa da env var
    app_urls = load_app_base_url_map()
    if not app_urls:
        return None

    # Se app_key specificato e presente nella mappa, usa quello
    if app_key and app_key in app_urls:
        return app_urls[app_key]

    # Fallback a default app key
    default_app = os.getenv('AGENT_BRIDGE_DEFAULT_APP_KEY', 'linkhub')
    if default_app in app_urls:
        return app_urls[default_app]

    requested_app = app_key or default_app
    print(f"❌ appKey '{requested_app}' non presente in APP_BASE_URL_MAP_JSON")
    return None

def execute_on_behalf(function_key, provider, provider_user_id, args=None, estimated_cost=None, app_key=None):
    """
    Esegui funzione tramite execute-on-behalf.
    OpenClaw → App BFF → Agent Bridge (con token utente risolto lato BFF)
    """
    service_id = get_service_id()
    service_key = get_service_key()
    
    if not service_id or not service_key:
        return None
    
    # Determina app key
    if not app_key:
        app_key = os.getenv('AGENT_BRIDGE_DEFAULT_APP_KEY', 'linkhub')
    
    base_url = get_app_base_url(app_key)
    if not base_url:
        return None

    url = f"{base_url}/api/agent/execute-on-behalf"
    
    payload = {
        "functionKey": function_key,
        "provider": provider,
        "providerUserId": provider_user_id,
        "args": args or {}
    }
    
    if estimated_cost:
        payload['estimatedCost'] = estimated_cost
    
    # Aggiungi appKey se necessario
    if app_key:
        payload['appKey'] = app_key
    
    data = json.dumps(payload).encode('utf-8')
    
    headers = {
        "Content-Type": "application/json",
        "X-Agent-Service-Id": service_id,
        "X-Agent-Service-Key": service_key
    }
    
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    
    # Retry logic per 429
    max_retries = 3
    attempt = 0
    
    while attempt < max_retries:
        try:
            print(f"🚀 Execute-on-behalf: {function_key}")
            print(f"   Provider: {provider} | User: {provider_user_id[:10]}...")
            print(f"   App: {app_key}")
            
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.loads(response.read().decode('utf-8'))
                
                if result.get('success'):
                    print(f"✅ Successo")
                    return result.get('result')
                else:
                    error = result.get('error', 'Unknown error')
                    print(f"❌ Errore: {error}")
                    return None
                    
        except urllib.error.HTTPError as e:
            error_body = e.read().decode()
            
            # Gestione 429 Rate Limit
            if e.code == 429:
                retry_after = int(e.headers.get('Retry-After', 1))
                attempt += 1
                
                if attempt < max_retries:
                    print(f"⚠️  Rate limit, attendo {retry_after}s...")
                    import time
                    time.sleep(retry_after)
                    continue
                else:
                    print(f"❌ Rate limit persistito")
                    return None
            
            # Gestione errori specifici link
            if e.code == 404:
                print(f"❌ Link non trovato")
                print(f"   💡 L'utente deve collegare il proprio account")
                print(f"   Usa: /link {app_key}")
            elif e.code == 410:
                print(f"❌ Link revocato o scaduto")
                print(f"   💡 L'utente deve rifare il linking")
            elif e.code == 403:
                print(f"❌ Delegation denied")
            elif e.code == 401:
                print(f"❌ Service credentials non valide")
            else:
                print(f"❌ HTTP {e.code}: {error_body}")
            
            return None
        except Exception as e:
            print(f"❌ Errore: {e}")
            return None
    
    return None

def execute_function(function_key, args=None, estimated_cost=None, app_key=None, user_token=None):
    """
    Esegui funzione (legacy mode o on-behalf).
    Se user_token è fornito, usa execute-on-behalf.
    """
    # Per ora supportiamo solo on-behalf mode
    # In futuro qui potrebbe esserci logica per scegliere tra direct e on-behalf
    
    # Estrai provider e user_id dal contesto (da implementare)
    provider = os.getenv('OPENCLAW_PROVIDER', 'discord')
    provider_user_id = os.getenv('OPENCLAW_PROVIDER_USER_ID')
    
    if not provider_user_id:
        print("❌ OPENCLAW_PROVIDER_USER_ID non configurato")
        return None
    
    return execute_on_behalf(
        function_key, 
        provider, 
        provider_user_id, 
        args, 
        estimated_cost, 
        app_key
    )

def show_status():
    """Verifica stato connessione"""
    service_id = get_service_id()
    service_key = get_service_key()
    
    if not service_id or not service_key:
        print("⚠️  Configurazione incompleta")
        return False
    
    masked_id = service_id[:8] + "..." if len(service_id) > 8 else service_id
    masked_key = service_key[:8] + "..." + service_key[-4:] if len(service_key) > 12 else "***"
    
    app_key = os.getenv('AGENT_BRIDGE_DEFAULT_APP_KEY', 'linkhub')
    base_url = get_app_base_url(app_key)
    
    print(f"📝 Agent Bridge v3.0.2 (Execute-on-Behalf)")
    print(f"   Service ID: {masked_id}")
    print(f"   Service Key: {masked_key}")
    print(f"   App: {app_key}")
    print(f"   URL: {base_url}")
    print()
    print("ℹ️  Usa execute-on-behalf per chiamate user-scoped")
    print("   Il token utente viene risolto lato app (BFF)")
    return True

def main():
    if len(sys.argv) < 2:
        print("Uso: agent-bridge <comando>")
        print("\nComandi:")
        print("  status                 - Verifica stato")
        print("  execute <functionKey>  - Esegui via execute-on-behalf")
        print("\nVariabili richieste:")
        print("  APP_BASE_URL_MAP_JSON      (mappa appKey -> baseUrl)")
        print("  OPENCLAW_SERVICE_ID")
        print("  OPENCLAW_SERVICE_KEY")
        print("  OPENCLAW_PROVIDER_USER_ID  (ID utente Discord/Telegram)")
        sys.exit(0)
    
    command = sys.argv[1]
    
    if command == 'status':
        result = show_status()
        sys.exit(0 if result else 1)
    
    elif command == 'execute':
        if len(sys.argv) < 3:
            print("❌ functionKey richiesto")
            sys.exit(1)
        
        function_key = sys.argv[2]
        args = None
        
        if len(sys.argv) > 3:
            try:
                args = json.loads(sys.argv[3])
            except json.JSONDecodeError:
                print(f"❌ JSON non valido")
                sys.exit(1)
        
        result = execute_function(function_key, args)
        
        if result is not None:
            print(json.dumps(result, indent=2))
            sys.exit(0)
        else:
            sys.exit(1)
    
    else:
        print(f"❌ Comando sconosciuto: {command}")
        sys.exit(1)

if __name__ == '__main__':
    main()