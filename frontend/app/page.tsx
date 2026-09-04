'use client';

import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:8000`;
  }
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
}

function formatMessageForMarkdown(content: string): string {
  if (!content) return '';
  return content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n/g, '\n');
}

interface ExtractedRecord {
  ref: string;
  amount: number;
  date: string;
  description?: string;
  status?: string;
}

interface MatchRecord {
  invoice_ref: string;
  invoice_amount: number;
  invoice_date: string;
  bank_amount: number;
  bank_date: string;
  match_type: string;
  confidence: number;
}

interface ExceptionRecord {
  invoice_ref: string;
  invoice_amount: number;
  invoice_date: string;
  exception_type: string;
  severity: string;
  recommended_action: string;
}

interface ReconciliationData {
  pdf_records_extracted: number;
  matched_count: number;
  exception_count: number;
  engine: string;
  source_dataset?: string;
  detected_year?: string;
  detected_month?: string;
  matches: MatchRecord[];
  exceptions: ExceptionRecord[];
}

interface ExtractPDFResponse {
  source: string;
  extracted_count: number;
  records: ExtractedRecord[];
  reconciliation: ReconciliationData;
}

interface SourceItem {
  type?: string;
  name: string;
  page?: number;
  engine?: string;
  snippet?: string;
}

interface ChatMessage {
  role: 'user' | 'ai';
  content: string;
  sources?: SourceItem[];
}

interface DatasetInfo {
  year?: string;
  month: string;
  label: string;
  has_razorpay: boolean;
  has_bank: boolean;
  has_invoices: boolean;
  razorpay_file?: string;
  bank_file?: string;
  invoice_file?: string;
  path?: string;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

export default function Home() {
  const [activeTab, setActiveTab] = useState<'reconciliation' | 'chat'>('reconciliation');

  // --- Hierarchical Period / Calendar State ---
  const [availableDatasets, setAvailableDatasets] = useState<DatasetInfo[]>([
    { year: '2026', month: 'july', label: 'July 2026', has_razorpay: true, has_bank: true, has_invoices: true, razorpay_file: 'razorpay_settlements_july_2026.csv', bank_file: 'bank_statement_july_2026.csv', invoice_file: 'invoices_july_2026.pdf' },
    { year: '2026', month: 'august', label: 'August 2026', has_razorpay: true, has_bank: true, has_invoices: true, razorpay_file: 'razorpay_settlements_august_2026.csv', bank_file: 'bank_statement_august_2026.csv', invoice_file: 'invoices_august_2026.pdf' },
  ]);
  const [availableYears, setAvailableYears] = useState<string[]>(['2026', '2025', '2024']);
  const [selectedYear, setSelectedYear] = useState<string>('2026');
  const [activeMonth, setActiveMonth] = useState<string>('july');
  const [showCalendarDropdown, setShowCalendarDropdown] = useState<boolean>(false);
  const calendarRef = useRef<HTMLDivElement>(null);

  // --- Ingestion Hub Modal Form State ---
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);
  const [ingestFile, setIngestFile] = useState<File | null>(null);
  const [ingestType, setIngestType] = useState<string>('bank');
  const [ingestYear, setIngestYear] = useState<string>('2026');
  const [ingestMonth, setIngestMonth] = useState<string>('august');
  const [ingestPasscode, setIngestPasscode] = useState<string>('');
  const [ingestStatus, setIngestStatus] = useState<string>('');
  const [isIngesting, setIsIngesting] = useState<boolean>(false);

  // --- Purge / Delete Dataset Modal State ---
  const [showDeleteModal, setShowDeleteModal] = useState<boolean>(false);
  const [deleteScope, setDeleteScope] = useState<string>('all');
  const [deletePasscode, setDeletePasscode] = useState<string>('');
  const [deleteStatus, setDeleteStatus] = useState<string>('');
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  // --- RAG Chat State with Session Persistence ---
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = sessionStorage.getItem('reconciler_chat_history');
        if (saved) return JSON.parse(saved);
      } catch {}
    }
    return [];
  });
  const [input, setInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && messages.length > 0) {
      try {
        sessionStorage.setItem('reconciler_chat_history', JSON.stringify(messages));
      } catch {}
    }
  }, [messages]);

  // --- PDF Reconciliation State ---
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfStatus, setPdfStatus] = useState('');
  const [isPdfLoading, setIsPdfLoading] = useState(false);
  const [pdfResult, setPdfResult] = useState<ExtractPDFResponse | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Close calendar popover on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (calendarRef.current && !calendarRef.current.contains(event.target as Node)) {
        setShowCalendarDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch available datasets on initial load
  useEffect(() => {
    const fetchDatasets = async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/finance/datasets`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.datasets) && data.datasets.length > 0) {
            setAvailableDatasets(data.datasets);
          }
          if (Array.isArray(data.years) && data.years.length > 0) {
            setAvailableYears(data.years);
          }
          if (data.active_year) {
            setSelectedYear(data.active_year);
          }
          if (data.active_month) {
            setActiveMonth(data.active_month);
          }
        }
      } catch {
        // Fallback to default state
      }
    };
    fetchDatasets();
  }, []);

  // Switch Active Month Handler
  const handleSelectPeriod = async (year: string, month: string) => {
    setSelectedYear(year);
    setActiveMonth(month);
    setShowCalendarDropdown(false);

    try {
      await fetch(`${getApiBaseUrl()}/finance/set-active-month`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month }),
      });
    } catch (err) {
      console.error('Failed to set active period:', err);
    }
  };

  // --- Ingestion Hub Statement Uploader ---
  const handleIngestDataset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ingestFile) return;
    setIsIngesting(true);
    setIngestStatus('Uploading dataset...');

    const formData = new FormData();
    formData.append('file', ingestFile);
    formData.append('dataset_type', ingestType);
    formData.append('month', `${ingestYear}/${ingestMonth}`);
    formData.append('passcode', ingestPasscode);

    try {
      const res = await fetch(`${getApiBaseUrl()}/finance/upload-dataset`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        setIngestStatus(`Statement batch saved successfully for ${ingestYear}/${ingestMonth}!`);
        setIngestFile(null);
        setSelectedYear(ingestYear);
        setActiveMonth(ingestMonth);
        
        // Refresh datasets list
        const dRes = await fetch(`${getApiBaseUrl()}/finance/datasets`);
        if (dRes.ok) {
          const dData = await dRes.json();
          setAvailableDatasets(dData.datasets);
          if (dData.years) setAvailableYears(dData.years);
        }
        setTimeout(() => {
          setShowUploadModal(false);
          setIngestStatus('');
        }, 1500);
      } else {
        const err = await res.json().catch(() => ({ error: 'Upload rejected by server.' }));
        setIngestStatus(err.error || 'Upload failed. Check Controller Passcode.');
      }
    } catch {
      setIngestStatus('Network error connecting to backend API.');
    } finally {
      setIsIngesting(false);
    }
  };

  // --- Purge / Delete Dataset Handler ---
  const handleDeleteDataset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deletePasscode) return;
    setIsDeleting(true);
    setDeleteStatus('Purging statement files from disk...');

    try {
      const res = await fetch(
        `${getApiBaseUrl()}/finance/dataset?year=${selectedYear}&month=${activeMonth}&file_type=${deleteScope}&passcode=${encodeURIComponent(deletePasscode)}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        setDeleteStatus('Dataset purged successfully.');
        setDeletePasscode('');
        
        // Refresh available datasets
        const dRes = await fetch(`${getApiBaseUrl()}/finance/datasets`);
        if (dRes.ok) {
          const dData = await dRes.json();
          setAvailableDatasets(dData.datasets);
          if (dData.years) setAvailableYears(dData.years);
          if (dData.active_month) setActiveMonth(dData.active_month);
          if (dData.active_year) setSelectedYear(dData.active_year);
        }
        setTimeout(() => {
          setShowDeleteModal(false);
          setDeleteStatus('');
        }, 1200);
      } else {
        const err = await res.json().catch(() => ({ error: 'Delete failed' }));
        setDeleteStatus(err.error || 'Delete failed. Check Controller Passcode.');
      }
    } catch {
      setDeleteStatus('Network error connecting to backend API.');
    } finally {
      setIsDeleting(false);
    }
  };

  // --- Chat Logic ---
  const handleChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isChatLoading) return;

    const userMessage = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setMessages((prev) => [...prev, { role: 'ai', content: '' }]);
    setIsChatLoading(true);

    try {
      const res = await fetch(`${getApiBaseUrl()}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: userMessage,
          year: selectedYear,
          month: activeMonth,
        }),
      });
      if (!res.ok) throw new Error(`Chat request failed with status ${res.status}`);

      const data = await res.json();
      const answer = typeof data?.answer === 'string' ? data.answer : 'No response returned.';
      const sources: SourceItem[] = Array.isArray(data?.sources) ? data.sources : [];

      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1].content = answer;
        updated[updated.length - 1].sources = sources;
        return updated;
      });
    } catch (err) {
      console.error('Chat error:', err);
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1].content = 'Connection error. Please check your backend service.';
        return updated;
      });
    } finally {
      setIsChatLoading(false);
    }
  };

  // --- PDF Extract & Reconcile Logic ---
  const handlePdfExtract = async () => {
    if (!pdfFile) return;
    setIsPdfLoading(true);
    setPdfStatus('Extracting invoices & running DuckDB multi-pass reconciliation...');

    const formData = new FormData();
    formData.append('file', pdfFile);

    try {
      const res = await fetch(`${getApiBaseUrl()}/finance/extract-pdf`, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data: ExtractPDFResponse = await res.json();
        setPdfResult(data);
        const detMonth = data.reconciliation?.detected_month;
        const detYear = data.reconciliation?.detected_year;
        if (detMonth) {
          setActiveMonth(detMonth);
          if (detYear) setSelectedYear(detYear);
          setPdfStatus(`Reconciliation complete! Auto-detected & switched active period to ${detMonth.toUpperCase()} ${detYear || selectedYear} (Processed ${data.extracted_count} invoices).`);
        } else {
          setPdfStatus(`Reconciliation complete! Processed ${data.extracted_count} invoices from ${data.source}.`);
        }
      } else {
        setPdfStatus(`PDF Extraction failed (${res.status}).`);
      }
    } catch {
      setPdfStatus('Error connecting to backend API.');
    } finally {
      setIsPdfLoading(false);
    }
  };

  // --- Export PDF Audit Report Logic ---
  const handleExportReport = async () => {
    if (!pdfResult) return;
    setIsExporting(true);

    try {
      const res = await fetch(`${getApiBaseUrl()}/finance/export-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_filename: pdfResult.source,
          extracted_count: pdfResult.extracted_count,
          matched_count: pdfResult.reconciliation.matched_count,
          exception_count: pdfResult.reconciliation.exception_count,
          exceptions: pdfResult.reconciliation.exceptions,
          matches: pdfResult.reconciliation.matches,
        }),
      });

      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Reconciliation_Audit_Report_${pdfResult.source.replace('.pdf', '')}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      } else {
        alert('Failed to generate PDF audit report.');
      }
    } catch {
      alert('Error connecting to backend API.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-blue-600 selection:text-white">
      {/* Top Enterprise Navigation Bar */}
      <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-6 py-3 flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-3">
          {/* Next.js Logo Mark */}
          <div className="w-8 h-8 rounded-lg bg-slate-950 border border-slate-700 flex items-center justify-center shadow-md">
            <svg className="w-5 h-5 text-white" viewBox="0 0 180 180" fill="none">
              <mask id="mask0_next" style={{ maskType: "alpha" }} maskUnits="userSpaceOnUse" x="0" y="0" width="180" height="180">
                <circle cx="90" cy="90" r="90" fill="black"/>
              </mask>
              <g mask="url(#mask0_next)">
                <circle cx="90" cy="90" r="90" fill="black" stroke="white" strokeWidth="6"/>
                <path d="M149.508 157.52L69.142 54H54V125.97H66.1136V69.3836L139.999 164.845C143.333 162.614 146.509 160.16 149.508 157.52Z" fill="white"/>
                <rect x="115" y="54" width="12" height="72" fill="white"/>
              </g>
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold tracking-tight text-white">AI Finance Controller</h1>
              <span className="px-2 py-0.5 text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
                Multi-Source Reconciler · Track 04
              </span>
            </div>
            <p className="text-[11px] text-slate-400">Autonomous Financial Reconciliation & Cash Position Engine</p>
          </div>
        </div>

        {/* Center: Navigation Tabs */}
        <div className="flex items-center bg-slate-800/80 p-1 rounded-xl border border-slate-700/60 shadow-inner">
          <button
            onClick={() => setActiveTab('reconciliation')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
              activeTab === 'reconciliation'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40'
            }`}
          >
            Reconciler Dashboard
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
              activeTab === 'chat'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40'
            }`}
          >
            AI Controller Chat
          </button>
        </div>

        {/* Right: Hierarchical Calendar / Period Selector & Ingestion Hub */}
        <div className="flex items-center gap-2.5">
          {/* Hierarchical Year/Month Calendar Selector */}
          <div className="relative" ref={calendarRef}>
            <button
              onClick={() => setShowCalendarDropdown(!showCalendarDropdown)}
              className="flex items-center gap-2 bg-slate-800/90 hover:bg-slate-800 text-slate-200 border border-slate-700 hover:border-blue-500/50 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors shadow-sm"
            >
              <span className="text-slate-400 font-mono text-[11px]">Period:</span>
              <span>{selectedYear} · <span className="capitalize">{activeMonth}</span></span>
              <span className="text-slate-400 text-[9px]">▼</span>
            </button>

            {/* Hierarchical Calendar Dropdown */}
            {showCalendarDropdown && (
              <div className="absolute right-0 mt-2 w-72 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-4 z-50 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                  <span className="text-xs font-bold text-slate-300">Select Audit Period</span>
                  {/* Year Switcher with Horizontal Scroll Navigation */}
                  <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
                    <button
                      type="button"
                      onClick={() => {
                        const idx = availableYears.indexOf(selectedYear);
                        if (idx < availableYears.length - 1) setSelectedYear(availableYears[idx + 1]);
                      }}
                      className="px-1 text-slate-400 hover:text-white text-[10px]"
                      title="Older Year"
                    >
                      ‹
                    </button>
                    <div className="flex items-center gap-1 max-w-[120px] overflow-x-auto scrollbar-none py-0.5">
                      {availableYears.map((yr) => (
                        <button
                          key={yr}
                          onClick={() => setSelectedYear(yr)}
                          className={`px-2 py-0.5 text-[11px] font-bold rounded shrink-0 transition-colors ${
                            selectedYear === yr
                              ? 'bg-blue-600 text-white'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {yr}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const idx = availableYears.indexOf(selectedYear);
                        if (idx > 0) setSelectedYear(availableYears[idx - 1]);
                      }}
                      className="px-1 text-slate-400 hover:text-white text-[10px]"
                      title="Newer Year"
                    >
                      ›
                    </button>
                  </div>
                </div>

                {/* 12 Months Grid */}
                <div className="grid grid-cols-3 gap-1.5">
                  {MONTH_NAMES.map((m) => {
                    const hasData = availableDatasets.some(
                      (d) => (d.year === selectedYear || !d.year) && d.month === m
                    );
                    const isSelected = selectedYear === selectedYear && activeMonth === m;

                    return (
                      <button
                        key={m}
                        onClick={() => handleSelectPeriod(selectedYear, m)}
                        className={`p-2 rounded-xl text-xs font-semibold flex flex-col items-center justify-center gap-1 transition-all ${
                          isSelected
                            ? 'bg-blue-600 text-white font-bold shadow-md shadow-blue-600/30'
                            : hasData
                            ? 'bg-slate-800/80 hover:bg-slate-700 text-slate-200 border border-slate-700/60'
                            : 'bg-slate-950/40 text-slate-500 hover:bg-slate-800/30 hover:text-slate-400'
                        }`}
                      >
                        <span className="capitalize">{m.slice(0, 3)}</span>
                        {hasData && (
                          <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white' : 'bg-emerald-400'}`} />
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="pt-2 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
                  <span>● Green dot = Statement data present</span>
                </div>
              </div>
            )}
          </div>

          {/* Ingest Statement Button */}
          <button
            onClick={() => setShowUploadModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 hover:border-blue-500 rounded-lg transition-all shadow-sm"
          >
            Ingest Statement
          </button>

          {/* Purge / Delete Dataset Button */}
          <button
            onClick={() => setShowDeleteModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-900/60 rounded-lg transition-all shadow-sm"
            title="Purge statement batch for active period"
          >
            Purge Period
          </button>
        </div>
      </header>

      {/* Main Workspace Area */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {/* ============================================================ */}
        {/* TAB 1: RECONCILER DASHBOARD & PDF EXTRACTOR */}
        {/* ============================================================ */}
        {activeTab === 'reconciliation' && (
          <div className="space-y-6">
            {/* Header & Ingestion Card */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 shadow-xl relative overflow-hidden backdrop-blur-sm">
              <div className="absolute top-0 right-0 -mt-8 -mr-8 w-64 h-64 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
              
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
                <div>
                  <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                    PDF Invoice Extractor & Settlement Reconciler
                  </h2>
                  <p className="text-sm text-slate-400 mt-1 max-w-2xl">
                    Extract multi-page invoice records via Groq Llama 3.3 70B, match against active banking ledgers, and resolve Many-to-One lump-sum settlement batches in DuckDB.
                  </p>
                  
                  {/* Current Active Dataset Badges */}
                  <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
                    <span className="text-slate-400">Active Period:</span>
                    <span className="px-2.5 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-md font-mono font-bold capitalize">
                      {selectedYear} / {activeMonth}
                    </span>
                    
                    {(() => {
                      const curDataset = availableDatasets.find(
                        (d) => (d.year === selectedYear || (!d.year && selectedYear === '2026')) && d.month === activeMonth
                      );
                      const hasBank = curDataset?.has_bank;
                      const hasRp = curDataset?.has_razorpay;

                      return (
                        <>
                          {hasBank ? (
                            <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-md font-mono flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              {curDataset?.bank_file || `bank_statement_${activeMonth}_${selectedYear}.csv`}
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-md font-mono flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                              bank_statement_{activeMonth}_{selectedYear}.csv (missing)
                            </span>
                          )}

                          {hasRp ? (
                            <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-md font-mono flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              {curDataset?.razorpay_file || `razorpay_settlements_${activeMonth}_${selectedYear}.csv`}
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-md font-mono flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                              razorpay_settlements_{activeMonth}_{selectedYear}.csv (missing)
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>

                {/* Upload Action Box */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 bg-slate-950/80 p-3 rounded-xl border border-slate-800">
                  <input
                    type="file"
                    accept=".pdf"
                    onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
                    className="text-xs text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700 cursor-pointer"
                  />
                  <button
                    onClick={handlePdfExtract}
                    disabled={!pdfFile || isPdfLoading}
                    className="px-5 py-2 text-xs font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg shadow-lg shadow-blue-600/20 transition-all flex items-center justify-center gap-2 shrink-0"
                  >
                    {isPdfLoading ? (
                      <>
                        <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Extracting & Matching...
                      </>
                    ) : (
                      'Extract & Reconcile'
                    )}
                  </button>
                </div>
              </div>

              {pdfStatus && (
                <div className="mt-4 px-4 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-xl text-xs text-blue-300 flex items-center justify-between">
                  <span>{pdfStatus}</span>
                  {pdfResult && (
                    <button
                      onClick={handleExportReport}
                      disabled={isExporting}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-lg text-xs shadow transition-all flex items-center gap-1.5"
                    >
                      {isExporting ? 'Generating Report...' : 'Export PDF Audit Report'}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Reconciliation KPI Metrics */}
            {pdfResult && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-lg relative overflow-hidden">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Total PDF Invoices</p>
                  <p className="text-3xl font-black text-white mt-1">{pdfResult.extracted_count}</p>
                  <p className="text-xs text-slate-400 mt-2">Extracted via Groq Llama 3.3 70B</p>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-lg relative overflow-hidden">
                  <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">Matched Invoices</p>
                  <p className="text-3xl font-black text-emerald-400 mt-1">{pdfResult.reconciliation.matched_count}</p>
                  <p className="text-xs text-emerald-500/80 mt-2">Exact, Fuzzy & Many-to-One</p>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-lg relative overflow-hidden">
                  <p className="text-xs font-semibold uppercase tracking-wider text-rose-400">Flagged Exceptions</p>
                  <p className="text-3xl font-black text-rose-400 mt-1">{pdfResult.reconciliation.exception_count}</p>
                  <p className="text-xs text-rose-500/80 mt-2">Requires Controller Review</p>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl shadow-lg relative overflow-hidden flex flex-col justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-blue-400">Reconciled Against</p>
                    <p className="text-xs font-mono font-bold text-blue-300 mt-2 break-words leading-relaxed" title={pdfResult.reconciliation.source_dataset}>
                      {pdfResult.reconciliation.source_dataset || `${selectedYear}/${activeMonth}`}
                    </p>
                  </div>
                  <span className="inline-block mt-3 self-start px-2 py-0.5 text-[10px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-md">
                    DuckDB SQL Engine
                  </span>
                </div>
              </div>
            )}

            {/* Extracted Invoices Table */}
            {pdfResult && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    Extracted PDF Invoice Records ({pdfResult.records.length})
                  </h3>
                  <span className="text-xs text-slate-400">Schema enforced via Pydantic</span>
                </div>

                <div className="overflow-x-auto border border-slate-800 rounded-xl">
                  <table className="min-w-full divide-y divide-slate-800 text-xs">
                    <thead className="bg-slate-950/70 text-slate-400 uppercase font-semibold">
                      <tr>
                        <th className="px-4 py-3 text-left">Invoice Ref</th>
                        <th className="px-4 py-3 text-left">Invoice Date</th>
                        <th className="px-4 py-3 text-right">Amount (₹)</th>
                        <th className="px-4 py-3 text-left">Description</th>
                        <th className="px-4 py-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                      {pdfResult.records.slice(0, 15).map((r, i) => (
                        <tr key={i} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-4 py-2.5 font-mono font-medium text-blue-400">{r.ref}</td>
                          <td className="px-4 py-2.5 text-slate-300">{r.date}</td>
                          <td className="px-4 py-2.5 text-right font-mono font-semibold text-white">
                            ₹{r.amount?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-2.5 text-slate-400 max-w-xs truncate">{r.description || 'Standard Invoice'}</td>
                          <td className="px-4 py-2.5 text-center">
                            <span className="px-2 py-0.5 text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
                              Extracted
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Exceptions Table */}
            {pdfResult && pdfResult.reconciliation.exceptions.length > 0 && (
              <div className="bg-slate-900 border border-rose-900/40 rounded-2xl p-6 shadow-xl space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-bold text-rose-400 flex items-center gap-2">
                    Reconciliation Exceptions & Action Items ({pdfResult.reconciliation.exceptions.length})
                  </h3>
                  <span className="text-xs text-rose-400/80 font-medium">Categorized Anomaly Action Items</span>
                </div>

                <div className="overflow-x-auto border border-slate-800 rounded-xl">
                  <table className="min-w-full divide-y divide-slate-800 text-xs">
                    <thead className="bg-slate-950/70 text-slate-400 uppercase font-semibold">
                      <tr>
                        <th className="px-4 py-3 text-left">Invoice Ref</th>
                        <th className="px-4 py-3 text-right">Amount (₹)</th>
                        <th className="px-4 py-3 text-left">Exception Type</th>
                        <th className="px-4 py-3 text-center">Severity</th>
                        <th className="px-4 py-3 text-left">Recommended Controller Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                      {pdfResult.reconciliation.exceptions.map((ex, i) => (
                        <tr key={i} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-4 py-2.5 font-mono font-medium text-rose-400">{ex.invoice_ref}</td>
                          <td className="px-4 py-2.5 text-right font-mono font-semibold text-white">
                            ₹{ex.invoice_amount?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[11px]">
                            <span className={`px-2 py-0.5 rounded-md font-semibold border ${
                              ex.exception_type === 'AMOUNT_MISMATCH'
                                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                : ex.exception_type === 'DATE_MISMATCH'
                                ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                                : ex.exception_type === 'MISSING_BANK'
                                ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                                : ex.exception_type === 'MISSING_INVOICE'
                                ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                                : ex.exception_type === 'DUPLICATE'
                                ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
                                : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                            }`}>
                              {ex.exception_type}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className="px-2 py-0.5 text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-full">
                              {ex.severity || 'HIGH'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-slate-300 font-medium">{ex.recommended_action}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 2: AI FINANCE CONTROLLER AGENT CHAT */}
        {/* ============================================================ */}
        {activeTab === 'chat' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-[calc(100vh-130px)]">
            {/* Left Knowledge Base & Prompt Chips */}
            <div className="lg:col-span-1 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between shadow-xl space-y-4">
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    Hybrid AI Agent
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Powered by LangGraph router, DuckDB SQL Engine, and PGVector dense semantic search.
                  </p>
                </div>

                {/* Accounting Period & Dataset Status Card */}
                <div className="p-3.5 bg-slate-950/80 rounded-xl border border-slate-800 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">Active Audit Period</span>
                    <span className="px-2 py-0.5 text-[10px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-md font-mono capitalize">
                      {selectedYear} / {activeMonth}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    AI synthesizes live DuckDB tables, exact transaction references, and forward cash settlement projections.
                  </p>
                  <div className="pt-2 border-t border-slate-800/80 space-y-1 text-[10px] text-slate-400 font-mono">
                    <div className="flex items-center justify-between">
                      <span>• Gateway:</span>
                      <span className="text-slate-300 truncate max-w-[140px]">razorpay_{activeMonth}_{selectedYear}.csv</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>• Bank:</span>
                      <span className="text-slate-300 truncate max-w-[140px]">bank_{activeMonth}_{selectedYear}.csv</span>
                    </div>
                  </div>
                </div>

                {/* Suggested Controller Prompts */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Suggested Inquiries</p>
                  {[
                    "What's the total unreconciled amount?",
                    'Why was REF1004 flagged as an anomaly?',
                    'Project upcoming cash settlement inflows for next week',
                    'Show all exceptions with amounts above ₹1,000',
                    `Summarize the ${activeMonth} reconciliation batch`,
                  ].map((prompt, idx) => (
                    <button
                      key={idx}
                      onClick={() => setInput(prompt)}
                      className="w-full text-left text-xs text-slate-300 bg-slate-950/50 hover:bg-blue-600/10 hover:text-blue-400 hover:border-blue-500/30 p-2.5 rounded-lg border border-slate-800 transition-all leading-snug"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Status Info */}
              <div className="pt-3 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
                <span>Active Period: <b className="text-blue-400 capitalize">{selectedYear} / {activeMonth}</b></span>
                <span className="text-emerald-400 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Live DuckDB</span>
              </div>
            </div>

            {/* Right Chat Stream */}
            <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden">
              {/* Messages Container */}
              <div className="flex-1 p-6 overflow-y-auto space-y-4">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shadow-inner font-mono text-sm font-bold">
                      AI
                    </div>
                    <h4 className="text-base font-bold text-white">Ask the AI Finance Controller</h4>
                    <p className="text-xs text-slate-400 max-w-md">
                      Inquire about reconciliation variances, transaction references, 7-day forward cash flow forecasts, or specific invoice discrepancies.
                    </p>
                  </div>
                ) : (
                  messages.map((m, idx) => (
                    <div
                      key={idx}
                      className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} space-y-1.5`}
                    >
                      <div className="flex items-center gap-2 px-1">
                        <span className="text-[11px] font-semibold text-slate-400">
                          {m.role === 'user' ? 'Finance Officer' : 'AI Controller'}
                        </span>
                      </div>

                      <div
                        className={`p-4 rounded-2xl text-xs max-w-2xl leading-relaxed shadow-md ${
                          m.role === 'user'
                            ? 'bg-blue-600 text-white rounded-br-none'
                            : 'bg-slate-950 border border-slate-800 text-slate-200 rounded-bl-none'
                        }`}
                      >
                        {m.content ? (
                          <div className="markdown-chat">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {formatMessageForMarkdown(m.content)}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-slate-400">
                            <span className="w-2.5 h-2.5 bg-blue-500 rounded-full animate-ping" />
                            Analyzing with DuckDB & Groq LLM...
                          </div>
                        )}

                        {/* Explainable AI Evidence Badges */}
                        {m.sources && m.sources.length > 0 && (
                          <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-1">
                              Sources:
                            </span>
                            {m.sources.map((s, sIdx) => (
                              <div
                                key={sIdx}
                                title={s.snippet || s.engine || s.name}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-slate-900 text-blue-300 border border-slate-700/60 shadow-sm cursor-help hover:border-blue-500/50 hover:bg-slate-800 transition-colors"
                              >
                                <span className="font-mono text-[9px] text-slate-400">{s.type === 'document' ? '[Doc]' : '[SQL]'}</span>
                                <span>{s.name}</span>
                                {s.page && <span className="text-slate-400 font-mono">p.{s.page}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Chat Input Bar */}
              <form onSubmit={handleChat} className="p-4 bg-slate-950/80 border-t border-slate-800 flex gap-3 items-center">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={`Ask a question about ${selectedYear}/${activeMonth} reconciliations...`}
                  className="flex-1 bg-slate-900 text-xs text-white border border-slate-800 focus:border-blue-500 rounded-xl px-4 py-2.5 outline-none transition-colors"
                />
                <button
                  type="submit"
                  disabled={!input.trim() || isChatLoading}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-xs font-bold text-white rounded-xl shadow-lg shadow-blue-600/20 transition-all flex items-center gap-1.5"
                >
                  Send
                </button>
              </form>
            </div>
          </div>
        )}
      </main>

      {/* ============================================================ */}
      {/* MODAL: INGESTION HUB (Hierarchical Multi-Source Statement Uploader) */}
      {/* ============================================================ */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                Ingest New Statement Batch
              </h3>
              <button
                onClick={() => setShowUploadModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Upload bank statement CSVs, Razorpay settlement reports, or invoices for any year/month. Files are organized into hierarchical folders (`data/&lt;year&gt;/&lt;month&gt;/`) and synced immediately with DuckDB.
            </p>

            <form onSubmit={handleIngestDataset} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Document Type</label>
                <select
                  value={ingestType}
                  onChange={(e) => setIngestType(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-white outline-none focus:border-blue-500"
                >
                  <option value="bank">Bank Statement (CSV/Excel)</option>
                  <option value="razorpay">Razorpay Settlement Report (CSV)</option>
                  <option value="invoice">Invoices Ledger (PDF)</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Year</label>
                  <select
                    value={ingestYear}
                    onChange={(e) => setIngestYear(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-white outline-none focus:border-blue-500"
                  >
                    <option value="2026">2026</option>
                    <option value="2025">2025</option>
                    <option value="2024">2024</option>
                    <option value="2023">2023</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 font-semibold mb-1">Month</label>
                  <select
                    value={ingestMonth}
                    onChange={(e) => setIngestMonth(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-white outline-none focus:border-blue-500 capitalize"
                  >
                    {MONTH_NAMES.map((m) => (
                      <option key={m} value={m} className="capitalize">
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">Select File</label>
                <input
                  type="file"
                  accept=".csv,.pdf,.xlsx"
                  onChange={(e) => setIngestFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-400 file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-300 hover:file:bg-slate-700 cursor-pointer"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Finance Controller Passcode
                </label>
                <input
                  type="password"
                  value={ingestPasscode}
                  onChange={(e) => setIngestPasscode(e.target.value)}
                  placeholder="Enter controller passcode"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-white outline-none focus:border-blue-500"
                  required
                />
              </div>

              {ingestStatus && (
                <p className="text-xs text-blue-400 font-medium bg-blue-500/10 p-2 rounded-lg border border-blue-500/20">
                  {ingestStatus}
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!ingestFile || isIngesting}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg font-bold shadow-lg shadow-blue-600/20 flex items-center gap-1.5"
                >
                  {isIngesting ? 'Uploading...' : 'Upload & Sync'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MODAL: PURGE / DELETE DATASET (Period Statement Cleaner) */}
      {/* ============================================================ */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-rose-900/60 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-rose-400 flex items-center gap-2">
                Purge Accounting Period Dataset
              </h3>
              <button
                onClick={() => setShowDeleteModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              You are about to purge dataset files for <b className="text-white capitalize">{selectedYear} / {activeMonth}</b>. This will permanently remove statement files from disk and refresh DuckDB tables.
            </p>

            <form onSubmit={handleDeleteDataset} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1">Purge Scope</label>
                <select
                  value={deleteScope}
                  onChange={(e) => setDeleteScope(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-white outline-none focus:border-rose-500"
                >
                  <option value="all">Entire Period (All CSVs & PDFs)</option>
                  <option value="bank">Bank Statement Only</option>
                  <option value="razorpay">Razorpay Settlement Only</option>
                  <option value="invoice">Invoices PDF Only</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1">
                  Finance Controller Passcode
                </label>
                <input
                  type="password"
                  value={deletePasscode}
                  onChange={(e) => setDeletePasscode(e.target.value)}
                  placeholder="Enter authorized passcode"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2 text-white outline-none focus:border-rose-500"
                  required
                />
              </div>

              {deleteStatus && (
                <p className="text-xs text-rose-400 font-medium bg-rose-500/10 p-2 rounded-lg border border-rose-500/20">
                  {deleteStatus}
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDeleteModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!deletePasscode || isDeleting}
                  className="px-5 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white rounded-lg font-bold shadow-lg shadow-rose-600/20 flex items-center gap-1.5"
                >
                  {isDeleting ? 'Purging...' : 'Confirm Purge'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}