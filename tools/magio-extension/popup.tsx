import { useState, useEffect } from "react"
import {
  getTrackingEnabled,
  setTrackingEnabled,
  initStorageListener,
  getExtensionToken,
  setExtensionToken,
} from "./lib/storage"

function IndexPopup() {
  const [enabled, setEnabled] = useState(true)
  const [token, setToken] = useState("")
  const [savedToken, setSavedToken] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    getTrackingEnabled().then(setEnabled)
    getExtensionToken().then((t) => {
      setSavedToken(t)
      setToken(t ?? "")
    })
    initStorageListener(setEnabled)
  }, [])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    setTrackingEnabled(next)
  }

  const saveToken = async () => {
    await setExtensionToken(token)
    setSavedToken(token.trim() || null)
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 1800)
  }

  const tokenChanged = (savedToken ?? "") !== token.trim()

  return (
    <div style={{ width: 300, padding: 20, fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{ background: '#16a34a', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 16 }}>
          W
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Wildflower Tracking</div>
          <div style={{ fontSize: 11, color: '#6b7280' }}>Email open tracker</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Auto-track emails</div>
          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Embed pixel on send</div>
        </div>
        <button
          onClick={toggle}
          style={{
            width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
            background: enabled ? '#10b981' : '#d1d5db', position: 'relative', transition: 'background 0.2s',
          }}
        >
          <div style={{
            width: 18, height: 18, borderRadius: 9, background: '#fff', position: 'absolute', top: 3,
            left: enabled ? 23 : 3, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          }} />
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>
          Per-recipient tracking token
        </div>
        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8, lineHeight: 1.4 }}>
          Paste the token from CRM Settings → Email tracking extension. Required
          to see who opened on group emails (2+ recipients, no attachments).
        </div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="wft_…"
          spellCheck={false}
          autoComplete="off"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none',
          }}
        />
        <button
          onClick={saveToken}
          disabled={!tokenChanged}
          style={{
            marginTop: 8, width: '100%', padding: '8px 10px', fontSize: 13, fontWeight: 500,
            color: '#fff', background: tokenChanged ? '#16a34a' : '#9ca3af',
            border: 'none', borderRadius: 6, cursor: tokenChanged ? 'pointer' : 'default',
          }}
        >
          {justSaved ? 'Saved ✓' : savedToken ? 'Update token' : 'Save token'}
        </button>
        <div style={{ fontSize: 11, color: savedToken ? '#16a34a' : '#9ca3af', marginTop: 6 }}>
          {savedToken ? 'Token connected.' : 'No token saved yet.'}
        </div>
      </div>

      <div style={{ marginTop: 14, fontSize: 11, color: '#9ca3af', textAlign: 'center' }}>
        Toggle also available in compose toolbar
      </div>
    </div>
  )
}

export default IndexPopup
