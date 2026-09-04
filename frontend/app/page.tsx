'use client';

import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function getApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL.replace(/\/+$/, '');
  }
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:8000`;
  }
  return 'http://127.0.0.1:8000';
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
  const [activeTab, setActiveTab] = useState<'reconciliation' | 'chat' | 'guide'>('reconciliation');

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
  const [isExportingExcel, setIsExportingExcel] = useState(false);

  // --- Financial Table Filter, Sort & Tab States ---
  const [activeTableTab, setActiveTableTab] = useState<'exceptions' | 'matches' | 'extracted'>('exceptions');
  const [tableSearch, setTableSearch] = useState('');
  const [anomalyFilter, setAnomalyFilter] = useState('ALL');
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState<'default' | 'amount_desc' | 'amount_asc' | 'date_desc' | 'date_asc'>('default');

  // --- 3-Way Triangulation Inspector Modal State ---
  const [inspectRecord, setInspectRecord] = useState<any | null>(null);
  const [inspectType, setInspectType] = useState<'exception' | 'match' | 'extracted' | null>(null);
  const [resolutionStatusMap, setResolutionStatusMap] = useState<Record<string, string>>({});
  const [copiedNotification, setCopiedNotification] = useState(false);
  const [isPeriodLocked, setIsPeriodLocked] = useState(false);

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
    setPdfStatus('Extracting invoice line items & running multi-pass ledger reconciliation...');

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

  // --- Export Excel Workbook (.xlsx) Logic ---
  const handleExportExcel = async () => {
    if (!pdfResult) return;
    setIsExportingExcel(true);

    try {
      const res = await fetch(`${getApiBaseUrl()}/finance/export-excel`, {
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
        const cleanName = pdfResult.source.replace(/\.(pdf|png|jpg|jpeg|webp)/i, '');
        a.download = `Reconciliation_Workbook_${cleanName}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      } else {
        alert('Failed to generate Excel reconciliation workbook.');
      }
    } catch {
      alert('Error connecting to backend API.');
    } finally {
      setIsExportingExcel(false);
    }
  };

  // --- Copy Gateway Support Tracer Helper (Works on both HTTPS and plain HTTP IP) ---
  const handleCopyTracer = (ref: string, amount: number, excType: string) => {
    const safeAmount = amount != null && !isNaN(amount) ? `₹${Number(amount).toFixed(2)}` : '₹0.00';
    const text = `RAZORPAY SETTLEMENT INQUIRY TICKET\n----------------------------------------\nReference ID: ${ref || 'N/A'}\nAccounting Period: ${selectedYear}/${activeMonth}\nGross Invoice Amount: ${safeAmount}\nAnomaly Class: ${excType || 'UNSPECIFIED'}\nRequested Action: Please provide settlement trace log & fee breakdown for payout reconciliation.`;
    
    if (typeof window !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopiedNotification(true);
          setTimeout(() => setCopiedNotification(false), 2500);
        })
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text: string) => {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      el.style.top = '-9999px';
      document.body.appendChild(el);
      el.focus();
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopiedNotification(true);
      setTimeout(() => setCopiedNotification(false), 2500);
    } catch (err) {
      console.error('Fallback copy failed:', err);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-blue-600 selection:text-white">
      {/* Top Enterprise Navigation Bar */}
      <header className="sticky top-0 z-40 bg-slate-900/95 backdrop-blur-md border-b border-slate-800 px-6 py-3 flex flex-wrap items-center justify-between gap-4 shadow-xl">
        <div className="flex items-center gap-3">
          {/* Institutional Emblem Logo */}
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-700 border border-blue-400/30 flex items-center justify-center shadow-lg shadow-blue-600/20">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 2h1.5v3H12V5zm-2 0h1.5v3H10V5zm-2 0h1.5v3H8V5zm11 14H5V9h14v10zm-8-7h6v2h-6v-2zm0 3h4v2h-4v-2z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-black tracking-wider uppercase text-white font-mono">NEXUS RECONCILER</h1>
              <span className="px-2 py-0.5 text-[9px] font-bold tracking-wider uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
                Audit Control
              </span>
            </div>
            <p className="text-[11px] text-slate-400">Autonomous Financial Reconciliation & Audit Intelligence</p>
          </div>
        </div>

        {/* Center: Navigation Tabs */}
        <div className="flex items-center bg-slate-800/80 p-1 rounded-xl border border-slate-700/60 shadow-inner">
          <button
            onClick={() => setActiveTab('reconciliation')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
              activeTab === 'reconciliation'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40'
            }`}
          >
            Reconciliation Dashboard
          </button>
          <button
            onClick={() => setActiveTab('chat')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
              activeTab === 'chat'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40'
            }`}
          >
            Q/A Agent
          </button>
          <button
            onClick={() => setActiveTab('guide')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
              activeTab === 'guide'
                ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40'
            }`}
          >
            User Guide
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
              
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div className="lg:col-span-7 xl:col-span-7 flex flex-col justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                      Invoice Document Extractor & Settlement Reconciler
                    </h2>
                    <p className="text-sm text-slate-400 mt-1">
                      Extract multi-line invoice records from digital PDFs or paper photo receipts, match against active banking ledgers, and resolve Many-to-One lump-sum settlement batches.
                    </p>
                  </div>
                  
                  {/* Current Active Dataset Badges */}
                  <div className="flex flex-wrap items-center gap-2 mt-4 text-xs">
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
                <div className="lg:col-span-5 xl:col-span-5 flex flex-col justify-start">
                  <div className="bg-slate-950/90 p-3 rounded-xl border border-slate-800 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 min-h-[58px]">
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp"
                      onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
                      className="min-w-0 flex-1 text-xs text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700 cursor-pointer"
                    />
                    <button
                      onClick={handlePdfExtract}
                      disabled={!pdfFile || isPdfLoading}
                      className="h-10 px-5 text-xs font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg shadow-lg shadow-blue-600/20 transition-all flex items-center justify-center gap-2 shrink-0 whitespace-nowrap"
                    >
                      {isPdfLoading ? (
                        <>
                          <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          <span>Extracting & Matching...</span>
                        </>
                      ) : (
                        'Extract & Reconcile'
                      )}
                    </button>
                  </div>
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
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Total Extracted Invoices</p>
                  <p className="text-3xl font-black text-white mt-1">{pdfResult.extracted_count}</p>
                  <p className="text-xs text-slate-400 mt-2">Automated Document Intelligence</p>
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
                    Relational Ledger Engine
                  </span>
                </div>
              </div>
            )}

            {/* Financial Ledger Tables & Audit Workspace */}
            {pdfResult && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
                {/* Table Header & View Mode Switcher */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
                  <div className="flex items-center gap-2 bg-slate-950 p-1 rounded-xl border border-slate-800">
                    <button
                      onClick={() => setActiveTableTab('exceptions')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                        activeTableTab === 'exceptions'
                          ? 'bg-rose-600 text-white shadow-md shadow-rose-600/30'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
                      Flagged Exceptions ({pdfResult.reconciliation.exceptions.length})
                    </button>
                    <button
                      onClick={() => setActiveTableTab('matches')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                        activeTableTab === 'matches'
                          ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      Matched Transactions ({pdfResult.reconciliation.matches.length})
                    </button>
                    <button
                      onClick={() => setActiveTableTab('extracted')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                        activeTableTab === 'extracted'
                          ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full bg-blue-400" />
                      Raw Extracted ({pdfResult.records.length})
                    </button>
                  </div>

                  {/* Financial Report Export & Sign-off Actions */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={handleExportReport}
                      disabled={isExporting}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold shadow-sm transition-all flex items-center gap-1.5"
                      title="Download PDF compliance audit report"
                    >
                      <span>📄</span>
                      {isExporting ? 'Generating PDF...' : 'Export PDF Report'}
                    </button>

                    <button
                      onClick={handleExportExcel}
                      disabled={isExportingExcel}
                      className="px-3 py-1.5 bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/80 rounded-lg text-xs font-semibold shadow-sm transition-all flex items-center gap-1.5"
                      title="Download multi-tab Excel reconciliation workbook"
                    >
                      <span>📊</span>
                      {isExportingExcel ? 'Generating XLSX...' : 'Export Excel (.xlsx)'}
                    </button>

                    <button
                      onClick={() => setIsPeriodLocked(!isPeriodLocked)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all flex items-center gap-1.5 ${
                        isPeriodLocked
                          ? 'bg-blue-600 text-white border-blue-500 shadow-md shadow-blue-600/30'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                      }`}
                      title="Controller Audit Lock"
                    >
                      <span>{isPeriodLocked ? '🔒' : '🔓'}</span>
                      {isPeriodLocked ? 'Period Locked & Certified' : 'Lock Period'}
                    </button>
                  </div>
                </div>

                {/* Instant Search & Multi-Column Filter Toolbar */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 items-center text-xs">
                  <div className="lg:col-span-5 relative">
                    <input
                      type="text"
                      value={tableSearch}
                      onChange={(e) => setTableSearch(e.target.value)}
                      placeholder="Search by Ref ID, Amount, Date, Action, or Anomaly..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2 text-white placeholder-slate-500 outline-none focus:border-blue-500"
                    />
                    {tableSearch && (
                      <button
                        onClick={() => setTableSearch('')}
                        className="absolute right-3 top-2 text-slate-400 hover:text-white text-xs font-bold"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {activeTableTab === 'exceptions' && (
                    <>
                      <div className="lg:col-span-3">
                        <select
                          value={anomalyFilter}
                          onChange={(e) => setAnomalyFilter(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2 text-slate-300 outline-none focus:border-blue-500"
                        >
                          <option value="ALL">All Anomaly Classes</option>
                          <option value="AMOUNT_MISMATCH">AMOUNT_MISMATCH</option>
                          <option value="DATE_MISMATCH">DATE_MISMATCH</option>
                          <option value="MISSING_BANK">MISSING_BANK</option>
                          <option value="MISSING_INVOICE">MISSING_INVOICE</option>
                          <option value="DUPLICATE">DUPLICATE</option>
                          <option value="GHOST_CREDIT">GHOST_CREDIT</option>
                        </select>
                      </div>

                      <div className="lg:col-span-2">
                        <select
                          value={severityFilter}
                          onChange={(e) => setSeverityFilter(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2 text-slate-300 outline-none focus:border-blue-500"
                        >
                          <option value="ALL">All Severities</option>
                          <option value="HIGH">High Severity</option>
                          <option value="MEDIUM">Medium Severity</option>
                          <option value="LOW">Low Severity</option>
                        </select>
                      </div>
                    </>
                  )}

                  <div className={`${activeTableTab === 'exceptions' ? 'lg:col-span-2' : 'lg:col-span-4'}`}>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as any)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2 text-slate-300 outline-none focus:border-blue-500"
                    >
                      <option value="default">Sort: Default Order</option>
                      <option value="amount_desc">Amount: High to Low</option>
                      <option value="amount_asc">Amount: Low to High</option>
                      <option value="date_desc">Date: Newest First</option>
                      <option value="date_asc">Date: Oldest First</option>
                    </select>
                  </div>
                </div>

                {/* TAB CONTENT 1: FLAGGED EXCEPTIONS */}
                {activeTableTab === 'exceptions' && (
                  <div className="space-y-2">
                    {(() => {
                      let list = pdfResult.reconciliation.exceptions;

                      if (tableSearch.trim()) {
                        const q = tableSearch.toLowerCase();
                        list = list.filter(
                          (ex) =>
                            ex.invoice_ref.toLowerCase().includes(q) ||
                            ex.invoice_amount.toString().includes(q) ||
                            ex.exception_type.toLowerCase().includes(q) ||
                            ex.recommended_action.toLowerCase().includes(q) ||
                            ex.invoice_date.toLowerCase().includes(q)
                        );
                      }

                      if (anomalyFilter !== 'ALL') {
                        list = list.filter((ex) => ex.exception_type.toUpperCase() === anomalyFilter);
                      }

                      if (severityFilter !== 'ALL') {
                        list = list.filter((ex) => (ex.severity || 'HIGH').toUpperCase() === severityFilter);
                      }

                      if (sortBy === 'amount_desc') {
                        list = [...list].sort((a, b) => b.invoice_amount - a.invoice_amount);
                      } else if (sortBy === 'amount_asc') {
                        list = [...list].sort((a, b) => a.invoice_amount - b.invoice_amount);
                      } else if (sortBy === 'date_desc') {
                        list = [...list].sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));
                      } else if (sortBy === 'date_asc') {
                        list = [...list].sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
                      }

                      if (list.length === 0) {
                        return (
                          <div className="p-8 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800">
                            No exceptions match current search/filter criteria.
                          </div>
                        );
                      }

                      return (
                        <div className="overflow-x-auto border border-rose-900/40 rounded-xl shadow-lg">
                          <table className="min-w-full divide-y divide-slate-800 text-xs">
                            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold">
                              <tr>
                                <th className="px-4 py-3 text-left">Invoice Ref</th>
                                <th className="px-4 py-3 text-left">Date</th>
                                <th className="px-4 py-3 text-right">Gross Amount</th>
                                <th className="px-4 py-3 text-left">Anomaly Category</th>
                                <th className="px-4 py-3 text-center">Severity</th>
                                <th className="px-4 py-3 text-left">Recommended Action</th>
                                <th className="px-4 py-3 text-center">Resolution</th>
                                <th className="px-4 py-3 text-center">Action</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                              {list.map((ex, i) => {
                                const customStatus = resolutionStatusMap[ex.invoice_ref];
                                return (
                                  <tr
                                    key={i}
                                    onClick={() => {
                                      setInspectRecord(ex);
                                      setInspectType('exception');
                                    }}
                                    className="hover:bg-slate-800/60 transition-colors cursor-pointer group"
                                  >
                                    <td className="px-4 py-2.5 font-mono font-bold text-rose-400 flex items-center gap-1.5">
                                      <span>{ex.invoice_ref}</span>
                                    </td>
                                    <td className="px-4 py-2.5 text-slate-300 font-mono">{ex.invoice_date}</td>
                                    <td className="px-4 py-2.5 text-right font-mono font-bold text-white whitespace-nowrap">
                                      ₹{ex.invoice_amount?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                    <td className="px-4 py-2.5 font-mono text-[11px]">
                                      <span
                                        className={`px-2 py-0.5 rounded-md font-semibold border ${
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
                                        }`}
                                      >
                                        {ex.exception_type}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-center">
                                      <span className="px-2 py-0.5 text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-full uppercase">
                                        {ex.severity || 'HIGH'}
                                      </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-slate-300 font-medium max-w-xs truncate" title={ex.recommended_action}>
                                      {ex.recommended_action}
                                    </td>
                                    <td className="px-4 py-2.5 text-center whitespace-nowrap">
                                      {customStatus ? (
                                        <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full">
                                          {customStatus}
                                        </span>
                                      ) : (
                                        <span className="px-2 py-0.5 text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700 rounded-full">
                                          Pending Review
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-4 py-2.5 text-center whitespace-nowrap">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setInspectRecord(ex);
                                          setInspectType('exception');
                                        }}
                                        className="px-2.5 py-1 text-[11px] font-bold bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30 rounded-lg transition-all"
                                      >
                                        Inspect 3-Way
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* TAB CONTENT 2: MATCHED TRANSACTIONS */}
                {activeTableTab === 'matches' && (
                  <div className="space-y-2">
                    {(() => {
                      let list = pdfResult.reconciliation.matches;

                      if (tableSearch.trim()) {
                        const q = tableSearch.toLowerCase();
                        list = list.filter(
                          (m) =>
                            m.invoice_ref.toLowerCase().includes(q) ||
                            m.invoice_amount.toString().includes(q) ||
                            (m.match_type && m.match_type.toLowerCase().includes(q)) ||
                            m.invoice_date.toLowerCase().includes(q)
                        );
                      }

                      if (sortBy === 'amount_desc') {
                        list = [...list].sort((a, b) => b.invoice_amount - a.invoice_amount);
                      } else if (sortBy === 'amount_asc') {
                        list = [...list].sort((a, b) => a.invoice_amount - b.invoice_amount);
                      } else if (sortBy === 'date_desc') {
                        list = [...list].sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));
                      } else if (sortBy === 'date_asc') {
                        list = [...list].sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
                      }

                      if (list.length === 0) {
                        return (
                          <div className="p-8 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800">
                            No matched transactions match current search criteria.
                          </div>
                        );
                      }

                      return (
                        <div className="overflow-x-auto border border-emerald-900/40 rounded-xl shadow-lg">
                          <table className="min-w-full divide-y divide-slate-800 text-xs">
                            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold">
                              <tr>
                                <th className="px-4 py-3 text-left">Invoice Ref</th>
                                <th className="px-4 py-3 text-left">Invoice Date</th>
                                <th className="px-4 py-3 text-right">Invoice Amount</th>
                                <th className="px-4 py-3 text-left">Bank Value Date</th>
                                <th className="px-4 py-3 text-right">Bank Settled</th>
                                <th className="px-4 py-3 text-left">Match Classification</th>
                                <th className="px-4 py-3 text-center">Confidence</th>
                                <th className="px-4 py-3 text-center">Action</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                              {list.map((m, i) => (
                                <tr
                                  key={i}
                                  onClick={() => {
                                    setInspectRecord(m);
                                    setInspectType('match');
                                  }}
                                  className="hover:bg-slate-800/60 transition-colors cursor-pointer group"
                                >
                                  <td className="px-4 py-2.5 font-mono font-bold text-emerald-400">{m.invoice_ref}</td>
                                  <td className="px-4 py-2.5 text-slate-300 font-mono">{m.invoice_date}</td>
                                  <td className="px-4 py-2.5 text-right font-mono font-bold text-white whitespace-nowrap">
                                    ₹{m.invoice_amount?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="px-4 py-2.5 text-slate-300 font-mono">{m.bank_date || m.invoice_date}</td>
                                  <td className="px-4 py-2.5 text-right font-mono font-bold text-emerald-400 whitespace-nowrap">
                                    ₹{(m.bank_amount || m.invoice_amount)?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="px-4 py-2.5 text-slate-300">
                                    <span className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-md">
                                      {m.match_type || 'Exact Match'}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
                                      {((m.confidence || 1.0) * 100).toFixed(0)}%
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 text-center whitespace-nowrap">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setInspectRecord(m);
                                        setInspectType('match');
                                      }}
                                      className="px-2.5 py-1 text-[11px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 rounded-lg transition-all"
                                    >
                                      Inspect
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* TAB CONTENT 3: RAW EXTRACTED INVOICES */}
                {activeTableTab === 'extracted' && (
                  <div className="space-y-2">
                    {(() => {
                      let list = pdfResult.records;

                      if (tableSearch.trim()) {
                        const q = tableSearch.toLowerCase();
                        list = list.filter(
                          (r) =>
                            r.ref.toLowerCase().includes(q) ||
                            r.amount.toString().includes(q) ||
                            r.date.toLowerCase().includes(q) ||
                            (r.description && r.description.toLowerCase().includes(q))
                        );
                      }

                      if (sortBy === 'amount_desc') {
                        list = [...list].sort((a, b) => b.amount - a.amount);
                      } else if (sortBy === 'amount_asc') {
                        list = [...list].sort((a, b) => a.amount - b.amount);
                      } else if (sortBy === 'date_desc') {
                        list = [...list].sort((a, b) => b.date.localeCompare(a.date));
                      } else if (sortBy === 'date_asc') {
                        list = [...list].sort((a, b) => a.date.localeCompare(b.date));
                      }

                      return (
                        <div className="overflow-x-auto border border-slate-800 rounded-xl shadow-lg">
                          <table className="min-w-full divide-y divide-slate-800 text-xs">
                            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold">
                              <tr>
                                <th className="px-4 py-3 text-left">Invoice Ref</th>
                                <th className="px-4 py-3 text-left">Invoice Date</th>
                                <th className="px-4 py-3 text-right">Amount (₹)</th>
                                <th className="px-4 py-3 text-left">Description</th>
                                <th className="px-4 py-3 text-center">Status</th>
                                <th className="px-4 py-3 text-center">Action</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/60 bg-slate-900/40">
                              {list.map((r, i) => (
                                <tr
                                  key={i}
                                  onClick={() => {
                                    setInspectRecord(r);
                                    setInspectType('extracted');
                                  }}
                                  className="hover:bg-slate-800/40 transition-colors cursor-pointer group"
                                >
                                  <td className="px-4 py-2.5 font-mono font-medium text-blue-400">{r.ref}</td>
                                  <td className="px-4 py-2.5 text-slate-300 font-mono">{r.date}</td>
                                  <td className="px-4 py-2.5 text-right font-mono font-bold text-white whitespace-nowrap">
                                    ₹{r.amount?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="px-4 py-2.5 text-slate-400 max-w-xs truncate">{r.description || 'Standard Invoice Item'}</td>
                                  <td className="px-4 py-2.5 text-center">
                                    <span className="px-2 py-0.5 text-[10px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
                                      {r.status || 'PAID'}
                                    </span>
                                  </td>
                                  <td className="px-4 py-2.5 text-center whitespace-nowrap">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setInspectRecord(r);
                                        setInspectType('extracted');
                                      }}
                                      className="px-2.5 py-1 text-[11px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 rounded-lg transition-all"
                                    >
                                      Inspect
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 2: FINANCIAL Q/A AGENT CHAT */}
        {/* ============================================================ */}
        {activeTab === 'chat' && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-[calc(100vh-130px)]">
            {/* Left Knowledge Base & Prompt Chips */}
            <div className="lg:col-span-1 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between shadow-xl space-y-4">
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    Financial Q/A Agent
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Multi-source ledger inquiry, reconciliation variance analysis, and forward cash settlement intelligence.
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
                    Synthesizes verified accounting ledgers, exact transaction references, and forward cash settlement projections.
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
                <span className="text-emerald-400 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Ledger Active</span>
              </div>
            </div>

            {/* Right Chat Stream */}
            <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden">
              {/* Messages Container */}
              <div className="flex-1 p-6 overflow-y-auto space-y-4">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shadow-inner font-mono text-sm font-bold">
                      QA
                    </div>
                    <h4 className="text-base font-bold text-white">Ask the Financial Q/A Agent</h4>
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
                          {m.role === 'user' ? 'Finance Officer' : 'Q/A Agent'}
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
                            Analyzing ledger transactions and accounting invariants...
                          </div>
                        )}

                        {/* Explainable Evidence Badges */}
                        {m.sources && m.sources.length > 0 && (
                          <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mr-1">
                              Sources:
                            </span>
                            {m.sources.map((s, sIdx) => (
                              <div
                                key={sIdx}
                                title={s.snippet || s.engine || s.name}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-medium bg-slate-900 text-blue-300 border border-slate-700/60 shadow-sm cursor-help hover:border-blue-500/50 hover:bg-slate-800 transition-colors"
                              >
                                <span className="text-[11px]">📎</span>
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

        {/* ============================================================ */}
        {/* TAB 3: USER GUIDE & SYSTEM PLAYBOOK */}
        {/* ============================================================ */}
        {activeTab === 'guide' && (
          <div className="space-y-8 max-w-5xl mx-auto pb-12">
            {/* Hero Overview */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-8 shadow-2xl relative overflow-hidden backdrop-blur-md">
              <div className="absolute top-0 right-0 -mt-12 -mr-12 w-80 h-80 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
              
              <div className="max-w-3xl space-y-3">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider">
                  Operational Architecture & Audit Playbook
                </div>
                <h2 className="text-2xl font-black text-white tracking-tight">
                  How Nexus Reconciler Operates
                </h2>
                <p className="text-sm text-slate-300 leading-relaxed">
                  Nexus Reconciler is an autonomous financial audit engine designed to eliminate manual spreadsheet comparisons, detect transaction anomalies, resolve lump-sum settlement batches, and guarantee complete ledger invariant integrity across multi-period banking records.
                </p>
              </div>
            </div>

            {/* 4-Step Operational Lifecycle */}
            <div className="space-y-4">
              <h3 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                4-Stage Reconciliation Workflow
              </h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between space-y-3">
                  <div className="space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 flex items-center justify-center font-mono font-bold text-xs">
                      01
                    </div>
                    <h4 className="text-sm font-bold text-white">Period Ingestion</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Upload bank statements (CSV/Excel) and gateway payout settlements for the target year and month via the Ingest Hub.
                    </p>
                  </div>
                  <div className="text-[10px] text-blue-400 font-mono bg-blue-500/5 px-2.5 py-1.5 rounded-lg border border-blue-500/10">
                    Hierarchical Storage Sync
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between space-y-3">
                  <div className="space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 flex items-center justify-center font-mono font-bold text-xs">
                      02
                    </div>
                    <h4 className="text-sm font-bold text-white">Document Extraction</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Provide digital PDF invoices or photo receipts of physical invoices. Document intelligence extracts invoice references, dates, and amounts.
                    </p>
                  </div>
                  <div className="text-[10px] text-indigo-400 font-mono bg-indigo-500/5 px-2.5 py-1.5 rounded-lg border border-indigo-500/10">
                    PDF & OCR Receipt Vision
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between space-y-3">
                  <div className="space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center font-mono font-bold text-xs">
                      03
                    </div>
                    <h4 className="text-sm font-bold text-white">Multi-Pass Matching</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Cross-references line items against bank credits: Pass 1 (Exact Ref & Amount), Pass 2 (Fuzzy Date ±3 Days), Pass 3 (Many-to-One Settlement Batches).
                    </p>
                  </div>
                  <div className="text-[10px] text-emerald-400 font-mono bg-emerald-500/5 px-2.5 py-1.5 rounded-lg border border-emerald-500/10">
                    Invariant Balance Check
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between space-y-3">
                  <div className="space-y-2">
                    <div className="w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 flex items-center justify-center font-mono font-bold text-xs">
                      04
                    </div>
                    <h4 className="text-sm font-bold text-white">Audit Q/A & Export</h4>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Query variances with the Financial Q/A Agent, project cash inflows, and download an executive PDF reconciliation compliance report.
                    </p>
                  </div>
                  <div className="text-[10px] text-cyan-400 font-mono bg-cyan-500/5 px-2.5 py-1.5 rounded-lg border border-cyan-500/10">
                    Certified PDF Report
                  </div>
                </div>
              </div>
            </div>

            {/* Financial Anomaly Classes */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-white tracking-tight">
                  Financial Anomaly Taxonomy & Resolution Matrix
                </h3>
                <span className="text-xs text-slate-400">Deterministic Exception Categorization</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-rose-400 px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded">
                      AMOUNT_MISMATCH
                    </span>
                    <span className="text-[10px] uppercase font-bold text-rose-400">High Severity</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    The transaction reference exists in the bank statement, but the deposited amount does not match the invoice figure.
                  </p>
                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                    <b className="text-slate-300">Action:</b> Verify merchant gateway fee deductions, currency conversion spreads, or partial settlements.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-amber-400 px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded">
                      DATE_MISMATCH
                    </span>
                    <span className="text-[10px] uppercase font-bold text-amber-400">Medium Severity</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Invoice matched by reference and amount, but settlement timestamp falls outside the standard 3-day processing window.
                  </p>
                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                    <b className="text-slate-300">Action:</b> Check weekend clearing delays, banking holidays, or payout holdbacks.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-rose-400 px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded">
                      MISSING_BANK
                    </span>
                    <span className="text-[10px] uppercase font-bold text-rose-400">High Severity</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Invoice or payment gateway entry exists, but zero corresponding credit entry appears in the banking ledger.
                  </p>
                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                    <b className="text-slate-300">Action:</b> Initiate gateway payout tracer or flag unsettled merchant balance.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-amber-400 px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 rounded">
                      MISSING_INVOICE
                    </span>
                    <span className="text-[10px] uppercase font-bold text-amber-400">Medium Severity</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Credit transaction present on the bank statement with no corresponding invoice or gateway settlement record.
                  </p>
                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                    <b className="text-slate-300">Action:</b> Confirm if direct wire transfer, vendor credit note, or interest credit.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-rose-400 px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded">
                      DUPLICATE
                    </span>
                    <span className="text-[10px] uppercase font-bold text-rose-400">Critical Severity</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Duplicate payment ID, settlement reference, or invoice number recorded more than once across active ledgers.
                  </p>
                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                    <b className="text-slate-300">Action:</b> Reverse duplicate credit entry or audit transaction idempotency.
                  </p>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-rose-400 px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 rounded">
                      GHOST_CREDIT
                    </span>
                    <span className="text-[10px] uppercase font-bold text-rose-400">Critical Severity</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Bank deposit recorded with an unidentifiable, corrupted, or synthetic reference string not matching gateway records.
                  </p>
                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-800">
                    <b className="text-slate-300">Action:</b> Flag for forensic review and notify treasury operations immediately.
                  </p>
                </div>
              </div>
            </div>

            {/* Invariant Balance & Ingestion Specs */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Mathematical Invariant Guarantee */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  Mathematical Invariant Guarantee
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Every reconciliation execution obeys the fundamental invariant:
                </p>
                <div className="p-3.5 bg-slate-950 rounded-xl border border-slate-800 font-mono text-xs text-blue-300 text-center font-bold">
                  Total Extracted Records = Matched Records + Flagged Exceptions
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Zero line items are left unclassified or dropped. Unmatched records are systematically preserved in the exceptions registry with complete audit trails.
                </p>
              </div>

              {/* Supported Multi-Source Formats */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  Unified Ingestion Matrix
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  The engine automatically parses and normalizes diverse financial documents:
                </p>
                <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside">
                  <li><b className="text-slate-300">Bank Statements:</b> Standard CSV and Excel ledgers (`bank_statement_*.csv`).</li>
                  <li><b className="text-slate-300">Payment Gateways:</b> Settlement breakdown reports (`razorpay_settlements_*.csv`).</li>
                  <li><b className="text-slate-300">Digital Invoices:</b> Vectorized PDF documents (`invoices_*.pdf`).</li>
                  <li><b className="text-slate-300">Paper Receipts:</b> Scanned photos (`.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`).</li>
                </ul>
              </div>
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
              Upload bank statement CSVs, Razorpay settlement reports, or invoices for any year/month. Files are organized into hierarchical folders (`data/&lt;year&gt;/&lt;month&gt;/`) and synced immediately with the relational ledger engine.
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
              You are about to purge dataset files for <b className="text-white capitalize">{selectedYear} / {activeMonth}</b>. This will permanently remove statement files from disk and refresh ledger state.
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
      {/* ============================================================ */}
      {/* MODAL: 3-WAY TRIANGULATION INSPECTOR & AUDIT BREAKDOWN */}
      {/* ============================================================ */}
      {/* ============================================================ */}
      {/* MODAL: 3-WAY TRIANGULATION INSPECTOR & AUDIT BREAKDOWN */}
      {/* ============================================================ */}
      {inspectRecord && (() => {
        const isException = inspectType === 'exception' || Boolean(inspectRecord.exception_type || inspectRecord.type);
        const excType = String(inspectRecord.exception_type || inspectRecord.type || '').toUpperCase();
        const isMissingBank = excType === 'MISSING_BANK';
        const isMissingInvoice = excType === 'MISSING_INVOICE' || excType === 'GHOST_CREDIT';
        const isAmountMismatch = excType === 'AMOUNT_MISMATCH';
        const isDateMismatch = excType === 'DATE_MISMATCH';

        // 1. Gross Invoice Amount
        const invoiceGross = isMissingInvoice 
          ? 0 
          : Number(inspectRecord.invoice_amount ?? inspectRecord.razorpay_amount ?? inspectRecord.amount ?? 0);

        // 2. Bank Realized Amount
        let bankRealized = 0;
        if (isMissingBank) {
          bankRealized = 0;
        } else if (inspectRecord.bank_amount != null) {
          bankRealized = Number(inspectRecord.bank_amount);
        } else if (isException) {
          if (isAmountMismatch) {
            const match = String(inspectRecord.recommended_action || '').match(/Bank credited ₹([\d,]+(\.\d+)?)/);
            if (match) {
              bankRealized = parseFloat(match[1].replace(/,/g, ''));
            } else {
              bankRealized = invoiceGross > 0 ? invoiceGross - (invoiceGross * 0.0236) : 0;
            }
          } else if (isDateMismatch) {
            bankRealized = invoiceGross;
          } else if (isMissingInvoice) {
            bankRealized = Number(inspectRecord.amount || 0);
          } else {
            bankRealized = 0;
          }
        } else {
          bankRealized = Number(inspectRecord.bank_amount ?? invoiceGross);
        }

        // 3. Dates
        const invoiceDocDate = isMissingInvoice
          ? 'Unrecorded (None)'
          : (inspectRecord.invoice_date || inspectRecord.razorpay_date || inspectRecord.date || '2026-08-19');

        const bankValueDate = isMissingBank
          ? 'Not Found (Unrealized)'
          : (inspectRecord.bank_date || (isDateMismatch ? 'Delayed (+3 days)' : invoiceDocDate));

        // 4. Statuses
        let bankStatusText = 'Cleared';
        let bankStatusClass = 'text-emerald-400 font-semibold';
        if (isMissingBank) {
          bankStatusText = '🔴 Missing / Unrealized';
          bankStatusClass = 'text-rose-400 font-bold';
        } else if (isMissingInvoice) {
          bankStatusText = '🟡 Unrecorded Credit';
          bankStatusClass = 'text-purple-400 font-bold';
        } else if (isAmountMismatch) {
          bankStatusText = '🟡 Amount Discrepancy';
          bankStatusClass = 'text-amber-400 font-bold';
        } else if (isDateMismatch) {
          bankStatusText = '🟡 Delayed Clearing (>T+2)';
          bankStatusClass = 'text-indigo-400 font-bold';
        }

        // 5. Gateway estimates
        const feeEst = invoiceGross * 0.02;
        const gstEst = feeEst * 0.18;
        const netEst = invoiceGross > 0 ? invoiceGross - (feeEst + gstEst) : 0;

        // 6. Mathematical delta
        const delta = isMissingBank
          ? -invoiceGross
          : isMissingInvoice
          ? bankRealized
          : isDateMismatch
          ? 0
          : (bankRealized - invoiceGross);

        return (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto">
            <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-3xl w-full p-6 sm:p-7 shadow-2xl space-y-5 my-8">
              {/* Modal Header */}
              <div className="flex items-start justify-between border-b border-slate-800 pb-4">
                <div>
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-sm font-black text-white px-2.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded-md">
                      {inspectRecord.invoice_ref || inspectRecord.merchant_ref || inspectRecord.ref || inspectRecord.payment_id || 'REF-N/A'}
                    </span>
                    <span
                      className={`px-2.5 py-0.5 text-xs font-bold rounded-full border ${
                        inspectType === 'exception' || isException
                          ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                          : inspectType === 'match'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                      }`}
                    >
                      {isException
                        ? excType || 'EXCEPTION'
                        : inspectType === 'match'
                        ? inspectRecord.match_type || 'RECONCILED'
                        : 'RAW EXTRACTED'}
                    </span>
                    <span className="text-xs text-slate-400 font-mono">
                      Period: {selectedYear}/{activeMonth}
                    </span>
                  </div>
                  <h3 className="text-base font-bold text-white mt-1.5">
                    3-Way Cross-Ledger Triangulation Inspector
                  </h3>
                </div>
                <button
                  onClick={() => setInspectRecord(null)}
                  className="text-slate-400 hover:text-white text-xl font-bold p-1 rounded-lg hover:bg-slate-800"
                >
                  ✕
                </button>
              </div>

              {/* 3-Column Triangulation Matrix */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
                {/* Column 1: Source Document Invoice */}
                <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 space-y-2.5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                      <span className="text-xs font-bold text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-blue-400" />
                        1. Source Invoice
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">PDF/OCR</span>
                    </div>

                    <div className="space-y-1.5 pt-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Reference:</span>
                        <span className="font-mono font-bold text-slate-200">
                          {inspectRecord.invoice_ref || inspectRecord.merchant_ref || inspectRecord.ref || 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Document Date:</span>
                        <span className="font-mono text-slate-300">
                          {invoiceDocDate}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Billed Status:</span>
                        {isMissingInvoice ? (
                          <span className="text-rose-400 font-semibold">MISSING</span>
                        ) : (
                          <span className="text-emerald-400 font-semibold">PAID</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800 flex justify-between items-baseline">
                    <span className="text-[11px] text-slate-400">Gross Invoice:</span>
                    <span className="font-mono font-bold text-sm text-white">
                      ₹{invoiceGross.toLocaleString('en-IN', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                </div>

                {/* Column 2: Gateway Settlement Line */}
                <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 space-y-2.5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                      <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-indigo-400" />
                        2. Gateway Report
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">Razorpay</span>
                    </div>

                    <div className="space-y-1.5 pt-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Payout Batch:</span>
                        <span className="font-mono text-slate-300 truncate max-w-[100px]">
                          {isMissingInvoice ? 'None' : `batch_${activeMonth}`}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">MDR Fee (2%):</span>
                        <span className="font-mono text-rose-400">
                          {isMissingInvoice ? '₹0.00' : `-₹${feeEst.toFixed(2)}`}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">GST on Fee (18%):</span>
                        <span className="font-mono text-rose-400">
                          {isMissingInvoice ? '₹0.00' : `-₹${gstEst.toFixed(2)}`}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800 flex justify-between items-baseline">
                    <span className="text-[11px] text-slate-400">Net Expected:</span>
                    <span className="font-mono font-bold text-sm text-indigo-300">
                      ₹{netEst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                {/* Column 3: Bank Statement Credit Entry */}
                <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4 space-y-2.5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                      <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                        3. Bank Ledger
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">Statement</span>
                    </div>

                    <div className="space-y-1.5 pt-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Value Date:</span>
                        <span className="font-mono text-slate-300">
                          {bankValueDate}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Narration / UTR:</span>
                        <span className="font-mono text-slate-300 truncate max-w-[110px]" title={isMissingBank ? 'No Entry' : `CMS/RPAY/${inspectRecord.invoice_ref || inspectRecord.merchant_ref || inspectRecord.ref || 'REF'}`}>
                          {isMissingBank ? 'No Entry Found' : `CMS/RPAY/${inspectRecord.invoice_ref || inspectRecord.merchant_ref || inspectRecord.ref || 'REF'}`}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Clearing Status:</span>
                        <span className={bankStatusClass}>{bankStatusText}</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800 flex justify-between items-baseline">
                    <span className="text-[11px] text-slate-400">Bank Deposited:</span>
                    <span className={`font-mono font-bold text-sm ${isMissingBank ? 'text-rose-400' : isAmountMismatch ? 'text-amber-400' : 'text-emerald-400'}`}>
                      ₹{bankRealized.toLocaleString('en-IN', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                </div>
              </div>

              {/* Variance & Mathematical Delta Breakdown */}
              <div className="p-4 bg-slate-950/90 rounded-2xl border border-slate-800 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-slate-300 uppercase tracking-wider">
                    Audit Variance Decomposition
                  </span>
                  {isException && (
                    <span className="font-mono font-bold text-rose-400">
                      Anomaly Class: {excType || 'UNMATCHED'}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-xs py-2 bg-slate-900/60 rounded-xl border border-slate-800/80 font-mono">
                  <div>
                    <span className="text-slate-400 text-[10px] block">Invoice Gross</span>
                    <span className="font-bold text-white">₹{invoiceGross.toFixed(2)}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 text-[10px] block">Bank Realized</span>
                    <span className={`font-bold ${isMissingBank ? 'text-rose-400' : 'text-emerald-400'}`}>
                      ₹{bankRealized.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 text-[10px] block">Ledger Variance (Δ)</span>
                    <span
                      className={`font-bold ${
                        isMissingBank
                          ? 'text-rose-400'
                          : isMissingInvoice
                          ? 'text-purple-400'
                          : isAmountMismatch
                          ? 'text-amber-400'
                          : isDateMismatch
                          ? 'text-indigo-400'
                          : Math.abs(delta) < 0.01
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {isMissingBank
                        ? `-₹${invoiceGross.toFixed(2)}`
                        : isMissingInvoice
                        ? `+₹${bankRealized.toFixed(2)}`
                        : isDateMismatch
                        ? '₹0.00 (Date Variance)'
                        : delta < 0
                        ? `-₹${Math.abs(delta).toFixed(2)}`
                        : delta > 0
                        ? `+₹${delta.toFixed(2)}`
                        : '₹0.00'}
                    </span>
                  </div>
                </div>

                <p className="text-xs text-slate-300 leading-relaxed">
                  <b className="text-white">Recommended Action:</b>{' '}
                  {inspectRecord.recommended_action ||
                    (isMissingBank
                      ? 'No matching credit found in bank statement; verify if payout was delayed (T+1) or dropped by gateway.'
                      : 'Transaction is fully reconciled with matching banking credit.')}
                </p>
              </div>

              {/* Action Buttons & Resolution Controls */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  {isException && (
                    <>
                      <button
                        onClick={() => {
                          const ref = inspectRecord.invoice_ref || inspectRecord.merchant_ref || inspectRecord.ref;
                          setResolutionStatusMap((prev) => ({
                            ...prev,
                            [ref]: 'RESOLVED (Fee Accepted)',
                          }));
                          setInspectRecord(null);
                        }}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-emerald-600/20"
                      >
                        ✓ Accept Fee Variance (GL 6100)
                      </button>

                      <button
                        onClick={() => {
                          const ref = inspectRecord.invoice_ref || inspectRecord.merchant_ref || inspectRecord.ref;
                          setResolutionStatusMap((prev) => ({
                            ...prev,
                            [ref]: 'INVESTIGATING (Treasury)',
                          }));
                          setInspectRecord(null);
                        }}
                        className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-bold transition-all shadow-md shadow-amber-600/20"
                      >
                        ⚠ Assign to Treasury
                      </button>
                    </>
                  )}

                  <button
                    onClick={() =>
                      handleCopyTracer(
                        inspectRecord.invoice_ref || inspectRecord.merchant_ref || inspectRecord.ref,
                        invoiceGross || bankRealized,
                        excType || 'INSPECTION'
                      )
                    }
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5"
                  >
                    <span>📋</span>
                    {copiedNotification ? 'Copied Tracer Ticket!' : 'Copy Support Ticket'}
                  </button>
                </div>

                <button
                  onClick={() => setInspectRecord(null)}
                  className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}