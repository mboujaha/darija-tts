import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import Settings from './components/Settings'
import SourceManager from './components/SourceManager'
import ScrapePanel from './components/ScrapePanel'
import ProcessPanel from './components/ProcessPanel'
import TranscribePanel from './components/TranscribePanel'
import DatasetPanel from './components/DatasetPanel'
import TrainPanel from './components/TrainPanel'
import SynthesizePanel from './components/SynthesizePanel'
import EvaluatePanel from './components/EvaluatePanel'
import ExportPanel from './components/ExportPanel'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="settings" element={<Settings />} />
        <Route path="sources" element={<SourceManager />} />
        <Route path="scrape" element={<ScrapePanel />} />
        <Route path="process" element={<ProcessPanel />} />
        <Route path="transcribe" element={<TranscribePanel />} />
        <Route path="dataset" element={<DatasetPanel />} />
        <Route path="train" element={<TrainPanel />} />
        <Route path="synthesize" element={<SynthesizePanel />} />
        <Route path="evaluate" element={<EvaluatePanel />} />
        <Route path="export" element={<ExportPanel />} />
      </Route>
    </Routes>
  )
}
