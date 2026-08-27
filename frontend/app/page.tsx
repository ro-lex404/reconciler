'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

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
  matches: MatchRecord[];
  exceptions: ExceptionRecord[];
}

interface ExtractPDFResponse {
  source: string;
  extracted_count: number;
  records: ExtractedRecord[];
  reconciliation: ReconciliationData;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<'chat' | 'reconciliation'>('reconciliation');

  // --- RAG Chat State ---
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([]);
  const [input, setInput] = useState('');
  const [kbFile, setKbFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);

  // --- PDF Reconciliation State ---
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfStatus, setPdfStatus] = useState('');
  const [isPdfLoading, setIsPdfLoading] = useState(false);
  const [pdfResult, setPdfResult] = useState<ExtractPDFResponse | null>(null);

  // --- File Upload Logic ---
  const handleUpload = async () => {
    if (!kbFile) return;
    setUploadStatus('Uploading...');
    const formData = new FormData();
    formData.append('file', kbFile);

    try {
      const res = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        setUploadStatus('File uploaded and sent to Celery worker!');
        setKbFile(null);
      } else {
        setUploadStatus(`Upload failed (${res.status}).`);
      }
    } catch {
      setUploadStatus('Error connecting to backend.');
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
      const res = await fetch(`${API_BASE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userMessage }),
      });
      if (!res.ok) throw new Error(`Chat request failed with status ${res.status}`);

      const data = await res.json();
      const answer = typeof data?.answer === 'string' ? data.answer : 'No response returned.';

      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1].content = answer;
        return updated;
      });
    } catch (err) {
      console.error('Chat error:', err);
    } finally {
      setIsChatLoading(false);
    }
  };

  // --- PDF Extract & Reconcile Logic ---
  const handlePdfExtract = async () => {
    if (!pdfFile) return;
    setIsPdfLoading(true);
    setPdfStatus('Processing PDF via LangGraph & DuckDB...');

    const formData = new FormData();
    formData.append('file', pdfFile);

    try {
      const res = await fetch(`${API_BASE_URL}/finance/extract-pdf`, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data: ExtractPDFResponse = await res.json();
        setPdfResult(data);
        setPdfStatus(`Successfully extracted ${data.extracted_count} records from ${data.source}!`);
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
  const [isExporting, setIsExporting] = useState(false);

  const handleExportReport = async () => {
    if (!pdfResult) return;
    setIsExporting(true);

    try {
      const res = await fetch(`${API_BASE_URL}/finance/export-report`, {
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
    <main className="flex h-screen bg-gray-100 p-4 text-black font-sans">
      <div className="flex flex-col w-full bg-white rounded-xl shadow-md border border-gray-200 overflow-hidden">
        {/* Navigation Bar */}
        <header className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg font-bold text-lg">RP</div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Razorpay Financial Reconciliation Engine</h1>
              <p className="text-xs text-slate-400">Powered by LangGraph, DuckDB & Groq Llama 3.3</p>
            </div>
          </div>
          <div className="flex bg-slate-800 p-1 rounded-lg border border-slate-700">
            <button
              onClick={() => setActiveTab('reconciliation')}
              className={`px-4 py-2 text-sm font-semibold rounded-md transition ${
                activeTab === 'reconciliation' ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:text-white'
              }`}
            >
              📄 PDF Extractor & Reconciler
            </button>
            <button
              onClick={() => setActiveTab('chat')}
              className={`px-4 py-2 text-sm font-semibold rounded-md transition ${
                activeTab === 'chat' ? 'bg-blue-600 text-white shadow' : 'text-slate-300 hover:text-white'
              }`}
            >
              💬 AI Agent Chat
            </button>
          </div>
        </header>

        {/* Tab 1: PDF Extractor & Reconciler */}
        {activeTab === 'reconciliation' && (
          <div className="flex-1 flex flex-col p-6 overflow-y-auto bg-gray-50 space-y-6">
            {/* Upload Box */}
            <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-gray-800">Extract & Reconcile Invoice PDF</h2>
                <p className="text-sm text-gray-500">
                  Upload any PDF invoice or statement. LangGraph will parse structured records and DuckDB will reconcile against bank statements.
                </p>
              </div>
              <div className="flex items-center gap-3 w-full md:w-auto">
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setPdfFile(e.target.files?.[0] || null)}
                  className="text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
                />
                <button
                  onClick={handlePdfExtract}
                  disabled={!pdfFile || isPdfLoading}
                  className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-blue-700 disabled:opacity-50 transition min-w-[180px]"
                >
                  {isPdfLoading ? 'Processing...' : 'Extract & Reconcile'}
                </button>
              </div>
            </div>

            {pdfStatus && (
              <div className={`p-4 rounded-lg font-medium text-sm border flex flex-col md:flex-row items-center justify-between gap-3 ${pdfResult ? 'bg-green-50 text-green-800 border-green-200' : 'bg-blue-50 text-blue-800 border-blue-200'}`}>
                <span>{pdfStatus}</span>
                {pdfResult && (
                  <button
                    onClick={handleExportReport}
                    disabled={isExporting}
                    className="bg-red-700 hover:bg-red-800 text-white font-bold text-xs px-4 py-2 rounded-lg shadow-sm transition flex items-center gap-2 whitespace-nowrap"
                  >
                    📥 {isExporting ? 'Generating Report...' : 'Export Audit PDF Report'}
                  </button>
                )}
              </div>
            )}

            {/* Metrics Dashboard */}
            {pdfResult && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                  <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Extracted Invoices</p>
                    <p className="text-3xl font-extrabold text-gray-900 mt-1">{pdfResult.extracted_count}</p>
                    <p className="text-xs text-gray-400 mt-1">Source: {pdfResult.source}</p>
                  </div>
                  <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-wider text-green-600">Reconciled Matches</p>
                    <p className="text-3xl font-extrabold text-green-700 mt-1">{pdfResult.reconciliation.matched_count}</p>
                    <p className="text-xs text-green-600 mt-1">Exact & Fuzzy Matched</p>
                  </div>
                  <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-wider text-red-500">Unmatched Exceptions</p>
                    <p className="text-3xl font-extrabold text-red-600 mt-1">{pdfResult.reconciliation.exception_count}</p>
                    <p className="text-xs text-red-500 mt-1">Action Required</p>
                  </div>
                  <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Measured Match Rate</p>
                    <p className="text-3xl font-extrabold text-blue-700 mt-1">
                      {((pdfResult.reconciliation.matched_count / (pdfResult.extracted_count || 1)) * 100).toFixed(2)}%
                    </p>
                    <p className="text-xs text-blue-600 mt-1">Invoice-vs-Bank Verification</p>
                  </div>
                  <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Engine Status</p>
                    <p className="text-xs font-bold text-gray-800 mt-2">{pdfResult.reconciliation.engine}</p>
                    <span className="inline-block mt-2 px-2.5 py-1 text-xs font-bold bg-blue-100 text-blue-800 rounded-full">
                      LangGraph Pipeline
                    </span>
                  </div>
                </div>

                {/* Extracted PDF Transactions Table */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-gray-800">Extracted PDF Invoice Records ({pdfResult.records.length})</h3>
                  </div>
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Ref ID</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Amount</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Date</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Category</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {pdfResult.records.map((rec, idx) => (
                          <tr key={idx} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-mono font-bold text-blue-600">{rec.ref}</td>
                            <td className="px-4 py-3 font-semibold text-gray-900">₹{rec.amount.toLocaleString()}</td>
                            <td className="px-4 py-3 text-gray-600">{rec.date}</td>
                            <td className="px-4 py-3 text-gray-600 capitalize">{rec.description || 'N/A'}</td>
                            <td className="px-4 py-3">
                              <span className="px-2 py-1 text-xs font-bold rounded-full bg-green-100 text-green-800">
                                {rec.status || 'PAID'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Reconciliation Matches */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
                  <h3 className="text-lg font-bold text-gray-800">Bank Statement Reconciliation Matches ({pdfResult.reconciliation.matches.length})</h3>
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Invoice Ref</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Invoice Amount</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Bank Amount</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Dates (Invoice / Bank)</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Match Type</th>
                          <th className="px-4 py-3 text-left font-semibold text-gray-600">Confidence</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {pdfResult.reconciliation.matches.map((m, idx) => (
                          <tr key={idx} className="hover:bg-gray-50">
                            <td className="px-4 py-3 font-mono font-bold text-gray-800">{m.invoice_ref}</td>
                            <td className="px-4 py-3 font-semibold text-gray-900">₹{m.invoice_amount.toLocaleString()}</td>
                            <td className="px-4 py-3 font-semibold text-gray-900">₹{m.bank_amount.toLocaleString()}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs">{m.invoice_date} / {m.bank_date}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2.5 py-1 text-xs font-bold rounded-full ${m.match_type === 'EXACT' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
                                {m.match_type}
                              </span>
                            </td>
                            <td className="px-4 py-3 font-semibold text-gray-700">{(m.confidence * 100).toFixed(0)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Exceptions Alert List */}
                {pdfResult.reconciliation.exceptions.length > 0 && (
                  <div className="bg-red-50 rounded-xl border border-red-200 p-6 space-y-4">
                    <h3 className="text-lg font-bold text-red-800">High-Severity Unmatched Exceptions ({pdfResult.reconciliation.exceptions.length})</h3>
                    <div className="space-y-3">
                      {pdfResult.reconciliation.exceptions.map((exc, idx) => (
                        <div key={idx} className="bg-white p-4 rounded-lg border border-red-200 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-red-700">{exc.invoice_ref}</span>
                              <span className="px-2 py-0.5 text-xs font-extrabold bg-red-100 text-red-800 rounded">{exc.severity} SEVERITY</span>
                              <span className="text-xs text-gray-500">{exc.invoice_date}</span>
                            </div>
                            <p className="text-sm font-semibold text-gray-800 mt-1">Amount: ₹{exc.invoice_amount.toLocaleString()}</p>
                            <p className="text-xs text-red-600 mt-1">💡 Action: {exc.recommended_action}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Tab 2: AI Agent Chat */}
        {activeTab === 'chat' && (
          <div className="flex-1 flex overflow-hidden">
            {/* Knowledge Base Sidebar */}
            <aside className="w-1/3 max-w-sm bg-white p-6 flex flex-col border-r border-gray-200">
              <h2 className="text-xl font-bold mb-2 text-gray-800">Knowledge Base</h2>
              <p className="text-sm text-gray-500 mb-6">
                Upload CSVs for DuckDB queries or PDFs for Vector Search.
              </p>
              <input
                type="file"
                onChange={(e) => setKbFile(e.target.files?.[0] || null)}
                className="mb-4 text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
              />
              <button
                onClick={handleUpload}
                disabled={!kbFile}
                className="bg-blue-600 text-white py-2 rounded-lg disabled:opacity-50 hover:bg-blue-700 transition font-medium"
              >
                Upload & Process
              </button>
              {uploadStatus && <p className="mt-4 text-sm text-blue-600 font-medium">{uploadStatus}</p>}
            </aside>

            {/* Chat Area */}
            <section className="flex-1 flex flex-col overflow-hidden bg-gray-50">
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {messages.map((msg, idx) => (
                  <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] p-4 rounded-xl shadow-sm ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white text-gray-800 border border-gray-200'}`}>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                          ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
                          table: ({ children }) => (
                            <div className="overflow-x-auto mb-2">
                              <table className="w-full border-collapse text-sm">{children}</table>
                            </div>
                          ),
                          th: ({ children }) => <th className="border border-gray-300 px-2 py-1 text-left">{children}</th>,
                          td: ({ children }) => <td className="border border-gray-300 px-2 py-1">{children}</td>,
                          code: ({ children }) => <code className="bg-black/10 px-1 py-0.5 rounded">{children}</code>,
                        }}
                      >
                        {formatMessageForMarkdown(msg.content)}
                      </ReactMarkdown>
                    </div>
                  </div>
                ))}
              </div>

              {/* Suggested Prompt Pills */}
              <div className="px-4 py-2.5 border-t border-gray-200 bg-gray-100 flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Suggested Prompts:</span>
                {[
                  "What's the total unreconciled amount?",
                  "Why was REF1004 flagged?",
                  "Show me all exceptions above ₹1,000",
                  "What's the projected settlement inflow next week?",
                ].map((promptText, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setInput(promptText)}
                    className="text-xs font-semibold bg-white border border-gray-300 text-blue-700 hover:bg-blue-50 hover:border-blue-400 px-3 py-1.5 rounded-full transition shadow-sm"
                  >
                    💡 {promptText}
                  </button>
                ))}
              </div>

              <form onSubmit={handleChat} className="p-4 border-t border-gray-200 flex gap-2 bg-white">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask about your financial data or reconciliation status..."
                  className="flex-1 border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-600 bg-white"
                />
                <button
                  type="submit"
                  disabled={isChatLoading}
                  className="bg-blue-600 text-white px-8 py-3 rounded-lg hover:bg-blue-700 transition font-bold disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isChatLoading ? 'Sending...' : 'Send'}
                </button>
              </form>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}