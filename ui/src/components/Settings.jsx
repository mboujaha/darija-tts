import React, { useEffect, useState, useRef } from 'react'
import api from '../api'

function Section({ title, children }) {
  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <div className="px-5 py-3 border-b border-zinc-700 bg-zinc-800/80">
        <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1">{label}</label>
      {hint && <p className="text-xs text-zinc-500 mb-1.5">{hint}</p>}
      {children}
    </div>
  )
}

const inputCls = "w-full bg-zinc-900 border border-zinc-600 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
const btnPrimary = "px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
const btnSecondary = "px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm font-medium rounded-md transition-colors disabled:opacity-50"

export default function Settings() {
  const [remoteServer, setRemoteServer] = useState({
    host: '',
    port: 22,
    username: '',
    auth_method: 'key',
    password: '',
    private_key_pem: '',
    private_key_passphrase: '',
    remote_data_dir: '/home/user/darija-tts/data',
    remote_checkpoints_dir: '/home/user/darija-tts/checkpoints',
    remote_python: 'python3',
  })
  const [general, setGeneral] = useState({
    hf_token: '',
    default_whisper_model: 'large-v3',
    default_min_snr: 15.0,
    default_min_confidence: 0.6,
  })
  const [testResult, setTestResult] = useState(null)
  const [testLoading, setTestLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [keyFileName, setKeyFileName] = useState('')
  const fileInputRef = useRef()

  useEffect(() => {
    api.get('/settings/remote-server').then(r => {
      if (r.data && Object.keys(r.data).length > 0) {
        setRemoteServer(prev => ({ ...prev, ...r.data }))
        if (r.data.private_key_pem === '**stored**') {
          setKeyFileName('(key stored)')
        }
      }
    }).catch(() => {})
    api.get('/settings/general').then(r => {
      if (r.data) setGeneral(prev => ({ ...prev, ...r.data }))
    }).catch(() => {})
  }, [])

  const handleKeyFileUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      await api.post('/settings/remote-server/upload-key', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setKeyFileName(file.name)
      setRemoteServer(prev => ({ ...prev, private_key_pem: '**stored**' }))
      setSaveMsg('SSH key uploaded')
      setTimeout(() => setSaveMsg(''), 3000)
    } catch (err) {
      setSaveMsg('Key upload failed: ' + err.message)
    }
  }

  const handlePasteKey = (val) => {
    setRemoteServer(prev => ({ ...prev, private_key_pem: val }))
    if (val.includes('PRIVATE KEY') || val.includes('OPENSSH')) {
      setKeyFileName('(pasted key)')
    }
  }

  const testConnection = async () => {
    setTestLoading(true)
    setTestResult(null)
    try {
      const r = await api.post('/settings/remote-server/test-connection')
      setTestResult({ ok: true, ...r.data })
    } catch (err) {
      setTestResult({ ok: false, message: err.message })
    } finally {
      setTestLoading(false)
    }
  }

  const saveRemoteServer = async () => {
    setSaving(true)
    try {
      await api.put('/settings/remote-server', remoteServer)
      setSaveMsg('Remote server settings saved')
    } catch (err) {
      setSaveMsg('Save failed: ' + err.message)
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 4000)
    }
  }

  const saveGeneral = async () => {
    setSaving(true)
    try {
      await api.put('/settings/general', general)
      setSaveMsg('General settings saved')
    } catch (err) {
      setSaveMsg('Save failed: ' + err.message)
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 4000)
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-100">Settings</h2>
        {saveMsg && (
          <span className={`text-sm px-3 py-1 rounded-md ${saveMsg.includes('failed') ? 'bg-red-900/50 text-red-400' : 'bg-emerald-900/50 text-emerald-400'}`}>
            {saveMsg}
          </span>
        )}
      </div>

      {/* Remote Training Server */}
      <Section title="Remote Training Server">
        <p className="text-xs text-zinc-500 -mt-2">
          Configure SSH access to the V100 training server. Credentials are stored locally in SQLite.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Host">
            <input
              className={inputCls}
              placeholder="192.168.1.100 or hostname"
              value={remoteServer.host}
              onChange={e => setRemoteServer(p => ({ ...p, host: e.target.value }))}
            />
          </Field>
          <Field label="Port">
            <input
              className={inputCls}
              type="number"
              value={remoteServer.port}
              onChange={e => setRemoteServer(p => ({ ...p, port: parseInt(e.target.value) || 22 }))}
            />
          </Field>
        </div>

        <Field label="Username">
          <input
            className={inputCls}
            placeholder="ubuntu"
            value={remoteServer.username}
            onChange={e => setRemoteServer(p => ({ ...p, username: e.target.value }))}
          />
        </Field>

        <Field label="Authentication Method">
          <div className="flex gap-3">
            {['key', 'password'].map(method => (
              <label key={method} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="auth_method"
                  value={method}
                  checked={remoteServer.auth_method === method}
                  onChange={() => setRemoteServer(p => ({ ...p, auth_method: method }))}
                  className="accent-emerald-500"
                />
                <span className="text-sm text-zinc-300 capitalize">{method === 'key' ? 'SSH Key / Certificate' : 'Password'}</span>
              </label>
            ))}
          </div>
        </Field>

        {remoteServer.auth_method === 'key' && (
          <div className="space-y-3 border border-zinc-700 rounded-lg p-4 bg-zinc-900/50">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">SSH Private Key</p>

            {/* Upload button */}
            <div className="flex items-center gap-3">
              <button
                className={btnSecondary}
                onClick={() => fileInputRef.current?.click()}
              >
                Upload Key File
              </button>
              {keyFileName && (
                <span className="text-xs text-emerald-400">{keyFileName}</span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pem,.key,.ppk,*"
                className="hidden"
                onChange={handleKeyFileUpload}
              />
            </div>

            {/* Or paste */}
            <Field
              label="Or paste PEM key"
              hint="Paste the contents of your ~/.ssh/id_rsa or id_ed25519 file"
            >
              <textarea
                className={`${inputCls} font-mono text-xs h-28 resize-none`}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                value={remoteServer.private_key_pem === '**stored**' ? '' : remoteServer.private_key_pem}
                onChange={e => handlePasteKey(e.target.value)}
              />
              {remoteServer.private_key_pem === '**stored**' && (
                <p className="text-xs text-emerald-500 mt-1">Key is stored — paste a new key to replace it</p>
              )}
            </Field>

            <Field label="Key Passphrase" hint="Leave empty if key has no passphrase">
              <input
                className={inputCls}
                type="password"
                placeholder="(optional)"
                value={remoteServer.private_key_passphrase === '**redacted**' ? '' : (remoteServer.private_key_passphrase || '')}
                onChange={e => setRemoteServer(p => ({ ...p, private_key_passphrase: e.target.value }))}
              />
            </Field>
          </div>
        )}

        {remoteServer.auth_method === 'password' && (
          <Field label="Password">
            <input
              className={inputCls}
              type="password"
              value={remoteServer.password === '**redacted**' ? '' : (remoteServer.password || '')}
              onChange={e => setRemoteServer(p => ({ ...p, password: e.target.value }))}
              placeholder="SSH password"
            />
          </Field>
        )}

        <div className="grid grid-cols-1 gap-3">
          <Field label="Remote Data Directory" hint="Where to store audio data on the training server">
            <input
              className={`${inputCls} font-mono text-xs`}
              value={remoteServer.remote_data_dir}
              onChange={e => setRemoteServer(p => ({ ...p, remote_data_dir: e.target.value }))}
            />
          </Field>
          <Field label="Remote Checkpoints Directory">
            <input
              className={`${inputCls} font-mono text-xs`}
              value={remoteServer.remote_checkpoints_dir}
              onChange={e => setRemoteServer(p => ({ ...p, remote_checkpoints_dir: e.target.value }))}
            />
          </Field>
          <Field label="Python Executable" hint="python3, /usr/bin/python3, or conda env path">
            <input
              className={`${inputCls} font-mono text-xs`}
              value={remoteServer.remote_python}
              onChange={e => setRemoteServer(p => ({ ...p, remote_python: e.target.value }))}
            />
          </Field>
        </div>

        {/* Test connection result */}
        {testResult && (
          <div className={`rounded-lg p-3 text-sm border ${testResult.ok ? 'bg-emerald-900/30 border-emerald-700 text-emerald-300' : 'bg-red-900/30 border-red-700 text-red-300'}`}>
            {testResult.ok ? (
              <div className="space-y-1">
                <p className="font-medium">Connection successful</p>
                {testResult.python_version && <p className="text-xs opacity-80">{testResult.python_version}</p>}
                {testResult.gpu_info && <p className="text-xs opacity-80">GPU: {testResult.gpu_info}</p>}
              </div>
            ) : (
              <p>{testResult.message}</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button className={btnPrimary} onClick={saveRemoteServer} disabled={saving}>
            {saving ? 'Saving...' : 'Save Remote Server'}
          </button>
          <button className={btnSecondary} onClick={testConnection} disabled={testLoading || !remoteServer.host}>
            {testLoading ? 'Testing...' : 'Test Connection'}
          </button>
        </div>
      </Section>

      {/* General Settings */}
      <Section title="General">
        <Field
          label="HuggingFace Token"
          hint="Required for pyannote speaker diarization (pyannote/speaker-diarization-3.1)"
        >
          <input
            className={inputCls}
            type="password"
            placeholder="hf_..."
            value={general.hf_token === '**redacted**' ? '' : (general.hf_token || '')}
            onChange={e => setGeneral(p => ({ ...p, hf_token: e.target.value }))}
          />
        </Field>

        <Field label="Default Whisper Model">
          <select
            className={inputCls}
            value={general.default_whisper_model}
            onChange={e => setGeneral(p => ({ ...p, default_whisper_model: e.target.value }))}
          >
            <option value="large-v3">large-v3 (best accuracy)</option>
            <option value="large-v2">large-v2</option>
            <option value="medium">medium (faster)</option>
            <option value="small">small (fastest)</option>
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Min SNR (dB)" hint="Clips below this SNR are rejected">
            <input
              className={inputCls}
              type="number"
              step="1"
              min="0"
              max="60"
              value={general.default_min_snr}
              onChange={e => setGeneral(p => ({ ...p, default_min_snr: parseFloat(e.target.value) }))}
            />
          </Field>
          <Field label="Min Confidence" hint="Whisper confidence threshold (0-1)">
            <input
              className={inputCls}
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={general.default_min_confidence}
              onChange={e => setGeneral(p => ({ ...p, default_min_confidence: parseFloat(e.target.value) }))}
            />
          </Field>
        </div>

        <div className="pt-2">
          <button className={btnPrimary} onClick={saveGeneral} disabled={saving}>
            {saving ? 'Saving...' : 'Save General Settings'}
          </button>
        </div>
      </Section>
    </div>
  )
}
