import { Component, StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { askBackend, checkBackend, getRankings } from './api'
import './styles.css'

const DEFAULT_YEARS = Array.from({ length: 9 }, (_, index) => 2017 + index)
const ALL_CATEGORIES = 'All categories'
const ALL_STATES = 'All States'
const NAV_ITEMS = [['Overview', 'grid', 'overview'], ['Trends', 'trend', 'trends'], ['Geography', 'map', 'geography'], ['Compare', 'compare', 'compare'], ['Insights', 'insight', 'insights']]
const parameters = [
  { key: 'tlr', label: 'TLR', full: 'Teaching, Learning & Resources', color: '#6272ff' },
  { key: 'rpc', label: 'RPC', full: 'Research & Professional Practice', color: '#19a979' },
  { key: 'go', label: 'GO', full: 'Graduation Outcomes', color: '#ed8e52' },
  { key: 'oi', label: 'OI', full: 'Outreach & Inclusivity', color: '#d96798' },
  { key: 'pr', label: 'PR', full: 'Perception', color: '#7d68d8' },
]
const axisOptions = [{ key: 'score', label: 'Overall Score' }, ...parameters]
const ICONS = { grid: '⊞', trend: '⌁', map: '⌖', compare: '⇄', insight: '✦', search: '⌕', arrow: '↗', filter: '⌄', dots: '•••', spark: '✧', send: '↑', bars: '▥', download: '↓' }
const icon = (name) => ICONS[name]
const AVATAR_COLORS = ['#6272ff', '#d96798', '#19a979', '#ed8e52', '#7d68d8']

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const toNum = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
function correlation(a, b) {
  if (a.length < 3) return null
  const aMean = mean(a)
  const bMean = mean(b)
  const numerator = a.reduce((sum, value, index) => sum + (value - aMean) * (b[index] - bMean), 0)
  const denominator = Math.sqrt(a.reduce((sum, value) => sum + (value - aMean) ** 2, 0) * b.reduce((sum, value) => sum + (value - bMean) ** 2, 0))
  return denominator ? numerator / denominator : null
}
const rankText = (row) => {
  if (!row) return '—'
  if (row.record_status === 'rank_withdrawn') return 'WD'
  if (row.rank_label) return row.rank_label
  return isNum(row.rank) ? String(row.rank) : '—'
}
const scoreText = (value) => (isNum(value) ? value : '—')
const initials = (name) => (String(name).match(/[A-Za-z]{3,}/g) || ['?']).slice(0, 2).map((word) => word[0].toUpperCase()).join('')
const compareRows = (a, b) => {
  const aRank = isNum(a.rank) ? a.rank : Infinity
  const bRank = isNum(b.rank) ? b.rank : Infinity
  if (aRank !== bRank) return aRank - bRank
  return (isNum(b.score) ? b.score : -1) - (isNum(a.score) ? a.score : -1) || a.institution.localeCompare(b.institution)
}
function normalizeRow(row) {
  return {
    ...row,
    year: Number(row.year),
    institution: row.institution || '',
    institution_key: row.institution_key || row.institution || '',
    state: row.state || '',
    category: row.category || '',
    rank: toNum(row.rank),
    score: toNum(row.score),
    tlr: toNum(row.tlr),
    rpc: toNum(row.rpc),
    go: toNum(row.go),
    oi: toNum(row.oi),
    pr: toNum(row.pr),
  }
}
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  // Neutralise spreadsheet formula injection as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}
function downloadCsv(filename, tableRows) {
  const columns = [['year', 'Year'], ['category', 'Category'], ['institution', 'Institution'], ['city', 'City'], ['state', 'State'], ['rank_label', 'Rank'], ['score', 'Score'], ['tlr', 'TLR'], ['rpc', 'RPC'], ['go', 'GO'], ['oi', 'OI'], ['pr', 'Perception'], ['source_url', 'Source']]
  const lines = [columns.map(([, label]) => label).join(',')]
  for (const row of tableRows) lines.push(columns.map(([key]) => csvCell(key === 'rank_label' ? rankText(row) : row[key])).join(','))
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---------------------------------------------------------------------------
// Presentational components
// ---------------------------------------------------------------------------
function Select({ value, onChange, children, className = '', label }) {
  return <label className={`select-wrap ${className}`}><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select><span aria-hidden="true">{icon('filter')}</span></label>
}

function MiniBars({ values, color = '#6272ff' }) {
  const top = Math.max(...values, 1)
  return <div className="mini-bars" aria-hidden="true">{values.map((value, index) => <i key={index} style={{ height: `${Math.max(14, value / top * 100)}%`, background: color }} />)}</div>
}

function LineChart({ data, activeInstitution }) {
  const points = data.filter((item) => isNum(item.score))
  if (!points.length) return <div className="chart-wrap line-chart empty-state">No published historical scores are available for this institution in the prepared dataset.</div>
  const width = 640, height = 255, pad = { x: 32, y: 18 }
  const scores = points.map((item) => item.score)
  const min = Math.floor(Math.min(...scores) / 5) * 5 - 2
  const max = Math.ceil(Math.max(...scores) / 5) * 5 + 2
  const point = (item, index) => [pad.x + index * (width - pad.x * 2) / Math.max(points.length - 1, 1), height - pad.y - (item.score - min) / (max - min) * (height - pad.y * 2)]
  const coords = points.map(point)
  const path = coords.map(([x, y], index) => `${index ? 'L' : 'M'}${x},${y}`).join(' ')
  const area = `${path} L${coords.at(-1)[0]},${height - pad.y} L${coords[0][0]},${height - pad.y} Z`
  const span = points.length > 1 ? `${points[0].year}–${points.at(-1).year}` : `${points[0].year} (single record)`
  return <div className="chart-wrap line-chart">
    <div className="chart-top"><div><span className="chart-label">NIRF score trajectory</span><strong>{activeInstitution}</strong></div><div className="trend-up">{span}</div></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`NIRF score trend for ${activeInstitution}, ${span}`}>
      {[0, 1, 2, 3].map((line) => {
        const y = pad.y + line * (height - pad.y * 2) / 3
        return <g key={line}><line x1={pad.x} y1={y} x2={width - pad.x} y2={y} className="grid-line" /><text x="2" y={y + 4}>{Math.round(max - line * (max - min) / 3)}</text></g>
      })}
      <defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#6272ff" stopOpacity=".24" /><stop offset="1" stopColor="#6272ff" stopOpacity="0" /></linearGradient></defs>
      {points.length > 1 && <path d={area} fill="url(#area)" />}
      {points.length > 1 && <path d={path} className="line-path" />}
      {points.map((item, index) => {
        const [x, y] = coords[index]
        return <g key={item.year}><circle cx={x} cy={y} r={index === points.length - 1 ? 5.5 : 3.5} className="data-point"><title>{`${item.year}: ${item.score}`}</title></circle><text x={x} y={height - 2} textAnchor="middle" className="axis-year">{String(item.year).slice(2)}</text></g>
      })}
    </svg>
  </div>
}

function BarChart({ data, expanded, onToggle, canExpand }) {
  const top = Math.max(...data.map((item) => item.count), 1)
  return <div className="chart-wrap state-chart" id="geography">
    <div className="chart-top"><div><span className="chart-label">Selected records</span><strong>Institutions by state</strong></div>{canExpand && <button type="button" className="quiet-button" onClick={onToggle}>{expanded ? 'Show top 5' : 'View all states'} {icon('arrow')}</button>}</div>
    {data.length === 0 ? <div className="empty-state">No state data is available for these filters.</div>
      : <div className={`state-bars${expanded ? ' scroll' : ''}`}>{data.map((item, index) => <div className="state-row" key={item.state}><span title={item.state}>{item.state}</span><div className="bar-track"><i style={{ width: `${item.count / top * 100}%`, background: index < 2 ? '#6272ff' : '#cbd0e3' }} /></div><b>{item.count}</b></div>)}</div>}
  </div>
}

function ScatterPlot({ data, xKey, yKey }) {
  if (data.length < 3) return <div className="scatter empty-state">At least three records with both numeric parameter values are required.</div>
  const width = 390, height = 255, pad = 30
  const xs = data.map((row) => row[xKey]), ys = data.map((row) => row[yKey])
  const xMin = Math.min(...xs) - 2, xMax = Math.max(...xs) + 2, yMin = Math.min(...ys) - 2, yMax = Math.max(...ys) + 2
  const point = (row) => [pad + (row[xKey] - xMin) / (xMax - xMin) * (width - pad * 2), height - pad - (row[yKey] - yMin) / (yMax - yMin) * (height - pad * 2)]
  return <div className="scatter"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Parameter correlation scatter chart">
    <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} className="grid-line" />
    <line x1={pad} y1={pad} x2={pad} y2={height - pad} className="grid-line" />
    {data.map((row) => { const [cx, cy] = point(row); return <circle key={`${row.category}-${row.institution_key}`} cx={cx} cy={cy} r="5" className="scatter-point"><title>{row.institution}</title></circle> })}
  </svg></div>
}

// Vertex offsets (from the pentagon centre) at a value of 100, in the same order as `parameters`.
const RADAR_CENTER = [125, 105]
const RADAR_VERTICES = [[0, -85], [95, -20], [59, 83], [-59, 83], [-95, -20]]
function Radar({ selected }) {
  const complete = parameters.every((item) => isNum(selected[item.key]))
  const at = (scale) => RADAR_VERTICES.map(([dx, dy]) => `${RADAR_CENTER[0] + dx * scale},${RADAR_CENTER[1] + dy * scale}`).join(' ')
  const dataPoints = RADAR_VERTICES.map(([dx, dy], index) => {
    const value = Math.min(100, Math.max(0, selected[parameters[index].key])) / 100
    return `${RADAR_CENTER[0] + dx * value},${RADAR_CENTER[1] + dy * value}`
  }).join(' ')
  return <div className="radar">
    <div className="radar-ring ring-one" /><div className="radar-ring ring-two" /><div className="radar-ring ring-three" />
    <svg viewBox="0 0 250 210" role="img" aria-label="Parameter profile radar chart"><polygon points={at(1)} className="radar-shape" />{complete && <polygon points={dataPoints} className="radar-data" />}</svg>
    {parameters.map((item, index) => <span key={item.key} className={`radar-label label-${index}`}>{item.label}<b>{scoreText(selected[item.key])}</b></span>)}
  </div>
}

class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error) { console.error(error) }
  render() {
    if (!this.state.error) return this.props.children
    return <div className="error-boundary" role="alert"><h2>Something went wrong displaying the dashboard.</h2><p>{this.state.error.message}</p><button type="button" className="export" onClick={() => window.location.reload()}>Reload</button></div>
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------
function App() {
  const [year, setYear] = useState('2025')
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [state, setState] = useState(ALL_STATES)
  const [institutionKey, setInstitutionKey] = useState('')
  const [xKey, setXKey] = useState('rpc')
  const [yKey, setYKey] = useState('score')
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState('Ask about trends, score distributions, states, or parameter relationships.')
  const [asking, setAsking] = useState(false)
  const [nav, setNav] = useState('Overview')
  const [tableSearch, setTableSearch] = useState('')
  const [tableExpanded, setTableExpanded] = useState(false)
  const [statesExpanded, setStatesExpanded] = useState(false)
  const [rows, setRows] = useState([])
  const [categories, setCategories] = useState([])
  const [dataStatus, setDataStatus] = useState('loading')
  const [dataNotice, setDataNotice] = useState('Loading prepared NIRF records…')
  const [dataMeta, setDataMeta] = useState({})
  const [backendStatus, setBackendStatus] = useState('checking')
  const [reloadToken, setReloadToken] = useState(0)
  const searchRef = useRef(null)
  const queryRef = useRef(null)
  const askCounter = useRef(0)

  // Load the prepared dataset.
  useEffect(() => {
    let mounted = true
    setDataStatus('loading')
    setDataNotice('Loading prepared NIRF records…')
    getRankings().then((payload) => {
      if (!mounted) return
      const loadedRows = (Array.isArray(payload.records) ? payload.records : []).map(normalizeRow).filter((row) => Number.isInteger(row.year) && row.institution)
      setRows(loadedRows)
      const loadedCategories = Array.isArray(payload.categories) && payload.categories.length ? payload.categories : [...new Set(loadedRows.map((row) => row.category).filter(Boolean))].sort()
      setCategories(loadedCategories)
      setDataMeta(payload.metadata || {})
      if (loadedRows.length) {
        const latestYear = Math.max(...loadedRows.map((row) => row.year))
        setYear(String(latestYear))
        setCategory((current) => (current !== ALL_CATEGORIES ? current : loadedCategories.includes('Overall') ? 'Overall' : ALL_CATEGORIES))
        setDataStatus('ready')
        setDataNotice(`Loaded ${loadedRows.length.toLocaleString()} prepared official ranking records. Check the audit report for collection gaps and category coverage.`)
      } else {
        setDataStatus('missing')
        setDataNotice(payload.metadata?.data_notice || 'No prepared NIRF dataset is loaded. Start the backend, then run: python scripts/collect_nirf.py from the project root.')
      }
    }).catch((error) => {
      if (mounted) { setDataStatus('error'); setDataNotice(error.message) }
    })
    return () => { mounted = false }
  }, [reloadToken])

  // Poll backend health.
  useEffect(() => {
    let mounted = true
    const check = async () => {
      try { await checkBackend(); if (mounted) setBackendStatus('online') } catch { if (mounted) setBackendStatus('offline') }
    }
    check()
    const timer = setInterval(check, 15000)
    return () => { mounted = false; clearInterval(timer) }
  }, [])

  const availableYears = useMemo(() => [...new Set(rows.map((row) => row.year))].sort((a, b) => a - b), [rows])
  const yearOptions = availableYears.length ? availableYears : DEFAULT_YEARS
  const availableStates = useMemo(() => [...new Set(rows.map((row) => row.state).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [rows])

  // Rows that match the category/state filters in every year (drives the sparkbars) and in the selected year.
  const scopedRows = useMemo(() => rows.filter((row) => (category === ALL_CATEGORIES || row.category === category) && (state === ALL_STATES || row.state === state)), [rows, category, state])
  const yearRows = useMemo(() => scopedRows.filter((row) => row.year === Number(year)), [scopedRows, year])
  const yearCounts = useMemo(() => yearOptions.map((item) => scopedRows.filter((row) => row.year === item).length), [scopedRows, yearOptions])
  const yearAverages = useMemo(() => yearOptions.map((item) => {
    const values = scopedRows.filter((row) => row.year === item && isNum(row.score)).map((row) => row.score)
    return values.length ? mean(values) : 0
  }), [scopedRows, yearOptions])

  // Institutions available under the current filters (best row per institution).
  const institutionOptions = useMemo(() => {
    // One row per institution: prefer its Overall entry, otherwise its best-ranked entry.
    const prefer = (row, current) => {
      const rowOverall = row.category === 'Overall'
      const currentOverall = current.category === 'Overall'
      return rowOverall !== currentOverall ? rowOverall : compareRows(row, current) < 0
    }
    const best = new Map()
    for (const row of yearRows) {
      const current = best.get(row.institution_key)
      if (!current || prefer(row, current)) best.set(row.institution_key, row)
    }
    return [...best.values()].sort(compareRows)
  }, [yearRows])
  const activeKey = institutionOptions.some((row) => row.institution_key === institutionKey) ? institutionKey : institutionOptions[0]?.institution_key || ''
  const selectedRow = institutionOptions.find((row) => row.institution_key === activeKey) || null
  const institutionName = selectedRow?.institution || ''
  const trendCategory = category !== ALL_CATEGORIES ? category : selectedRow?.category
  const trendData = useMemo(() => {
    if (!activeKey) return []
    const perYear = new Map()
    for (const row of rows) {
      if (row.institution_key !== activeKey || (trendCategory && row.category !== trendCategory)) continue
      const current = perYear.get(row.year)
      if (!current || compareRows(row, current) < 0) perYear.set(row.year, row)
    }
    return [...perYear.values()].sort((a, b) => a.year - b.year)
  }, [rows, activeKey, trendCategory])
  const trendScores = trendData.filter((row) => isNum(row.score))
  const trendDelta = trendScores.length > 1 ? (trendScores.at(-1).score - trendScores[0].score).toFixed(2) : null

  const stateAll = useMemo(() => {
    const grouped = new Map()
    for (const row of yearRows) {
      const name = row.state || 'Unknown'
      if (!grouped.has(name)) grouped.set(name, new Set())
      grouped.get(name).add(row.institution_key)
    }
    return [...grouped.entries()].map(([name, set]) => ({ state: name, count: set.size })).sort((a, b) => b.count - a.count || a.state.localeCompare(b.state))
  }, [yearRows])
  const stateData = stateAll.slice(0, 5)

  const selected = selectedRow || { rank: null, rank_label: '', score: null, tlr: null, rpc: null, go: null, oi: null, pr: null, source_url: '' }
  const correlationRows = useMemo(() => yearRows.filter((row) => isNum(row[xKey]) && isNum(row[yKey])), [yearRows, xKey, yKey])
  const corr = useMemo(() => correlation(correlationRows.map((row) => row[xKey]), correlationRows.map((row) => row[yKey])), [correlationRows, xKey, yKey])
  const scores = useMemo(() => yearRows.map((row) => row.score).filter(isNum), [yearRows])
  const medianScore = median(scores)

  const tableRows = useMemo(() => {
    const needle = tableSearch.trim().toLowerCase()
    const matching = needle ? yearRows.filter((row) => `${row.institution} ${row.state} ${row.city}`.toLowerCase().includes(needle)) : yearRows
    return [...matching].sort(compareRows)
  }, [yearRows, tableSearch])
  const visibleRows = tableExpanded ? tableRows : tableRows.slice(0, 5)

  const goTo = (item, target) => {
    setNav(item)
    document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const focusSearch = () => {
    document.getElementById('table')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTableExpanded(true)
    setTimeout(() => searchRef.current?.focus(), 250)
  }
  const exportReport = () => downloadCsv(`nirf-${year}-${category === ALL_CATEGORIES ? 'all-categories' : category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`, [...yearRows].sort(compareRows))

  const submitQuestion = async (text) => {
    const trimmed = text.trim()
    if (!trimmed) { setAnswer('Please enter a question first.'); return }
    const ticket = ++askCounter.current
    setAsking(true)
    setAnswer('Connecting to NIRF Insight backend…')
    try {
      const result = await askBackend(trimmed)
      if (ticket === askCounter.current) setAnswer(result.answer)
    } catch (error) {
      if (ticket === askCounter.current) setAnswer(`Backend error: ${error.message}`)
    } finally {
      if (ticket === askCounter.current) setAsking(false)
    }
  }
  const respond = (event) => { event.preventDefault(); void submitQuestion(query) }
  const ask = (text) => { setQuery(text); void submitQuestion(text) }

  const ready = dataStatus === 'ready'
  return <div className="dashboard-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">N</span><div><b>NIRF Insight</b><small>Rankings intelligence</small></div></div>
      <nav className="side-nav" aria-label="Sections">{NAV_ITEMS.map(([item, symbol, target]) => <button type="button" key={item} className={nav === item ? 'active' : ''} aria-current={nav === item ? 'true' : undefined} onClick={() => goTo(item, target)}><span aria-hidden="true">{icon(symbol)}</span>{item}</button>)}</nav>
      <div className="sidebar-callout"><span aria-hidden="true">{icon('spark')}</span><b>Ask in natural language</b><p>Turn any NIRF question into an analysis.</p><button type="button" onClick={() => { goTo('Insights', 'insights'); setTimeout(() => queryRef.current?.focus(), 350) }}>Try it {icon('arrow')}</button></div>
      <div className="profile"><div className="avatar">SC</div><div><b>Research workspace</b><small>{availableYears.length ? `${availableYears.at(-1)} data release` : 'No data loaded'}</small></div><span aria-hidden="true">{icon('dots')}</span></div>
    </aside>
    <main className="main-area" id="overview">
      <header className="header">
        <div><p className="crumb">NIRF DATA EXPLORER <span>/</span> {nav.toUpperCase()}</p><h1>India’s higher education,<br /><em>in focus.</em></h1></div>
        <div className="header-actions">
          <span className={`status-pill ${backendStatus}`} role="status" title="Backend API status"><i />{backendStatus === 'online' ? 'API online' : backendStatus === 'offline' ? 'API offline' : 'Checking API…'}</span>
          <button type="button" className="icon-button" aria-label="Search institutions" title="Search institutions" onClick={focusSearch} disabled={!ready}>{icon('search')}</button>
          <button type="button" className="export" onClick={exportReport} disabled={!yearRows.length} title="Download the current view as CSV">Export report {icon('download')}</button>
        </div>
      </header>

      <section className="filters">
        <div className="filter-intro"><span aria-hidden="true">{icon('bars')}</span><div><b>Explore the ranking landscape</b><small>{availableYears.length ? `${availableYears[0]}–${availableYears.at(-1)}` : '2017–2025'} · all available categories</small></div></div>
        <Select label="Year" value={year} onChange={setYear}>{yearOptions.map((item) => <option key={item} value={String(item)}>{item}</option>)}</Select>
        <Select label="Category" value={category} onChange={setCategory}><option value={ALL_CATEGORIES}>{ALL_CATEGORIES}</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</Select>
        <Select label="State" value={state} onChange={setState}><option value={ALL_STATES}>{ALL_STATES}</option>{availableStates.map((item) => <option key={item} value={item}>{item}</option>)}</Select>
      </section>

      {!ready && <section className={`data-notice ${dataStatus}`} role="status"><b>{dataStatus === 'loading' ? 'Loading NIRF data' : dataStatus === 'error' ? 'Data connection error' : 'Official dataset not prepared'}</b><span>{dataNotice}</span>{dataStatus !== 'loading' && <button type="button" className="retry-button" onClick={() => setReloadToken((value) => value + 1)}>Retry</button>}</section>}
      {ready && <section className="data-notice" role="status"><b>Official data loaded</b><span>{dataNotice} Years available: {availableYears.join(', ') || 'check audit report'}.{dataMeta.is_complete === false ? ' The audit reports the dataset as incomplete; check collection errors before drawing conclusions.' : ''}</span></section>}
      {ready && yearRows.length === 0 && <section className="data-notice missing" role="status"><b>No records for this selection</b><span>No {category === ALL_CATEGORIES ? '' : `${category} `}rankings were published{state === ALL_STATES ? '' : ` for ${state}`} in {year}. Not every category existed in every year; try another year or filter.</span></section>}

      <section className="metrics">
        <article><span className="metric-label">Ranking records</span><strong>{yearRows.length.toString().padStart(3, '0')}</strong><div><span className="up">Published data</span><small>selected view</small></div><MiniBars values={yearCounts} /></article>
        <article><span className="metric-label">Average NIRF score</span><strong>{scores.length ? mean(scores).toFixed(1) : '—'}</strong><div><span className="up">Mean score</span><small>selected view</small></div><MiniBars values={yearAverages} color="#19a979" /></article>
        <article><span className="metric-label">Most represented state</span><strong className="state-metric" title={stateData[0]?.state}>{stateData[0]?.state || '—'}</strong><div><span className="up">{stateData[0]?.count || 0} institutions</span><small>in selected view</small></div><div className="state-dots">{stateData.map((item, index) => <i key={item.state} style={{ opacity: 1 - index * 0.14 }} />)}</div></article>
        <article className="quick-insight"><span aria-hidden="true">{icon('spark')}</span><p><b>Quick insight</b>{trendDelta == null || !institutionName ? 'Historical score comparison is unavailable for this institution in the prepared records.' : `${institutionName}’s published score changed by ${trendDelta} points between ${trendScores[0].year} and ${trendScores.at(-1).year}.`}</p><button type="button" aria-label="Open insights" onClick={() => goTo('Insights', 'insights')}>{icon('arrow')}</button></article>
      </section>

      <section className="chart-grid" id="trends">
        <LineChart data={trendData} activeInstitution={institutionName || 'No institution selected'} />
        <BarChart data={statesExpanded ? stateAll : stateData} expanded={statesExpanded} canExpand={stateAll.length > 5} onToggle={() => setStatesExpanded((value) => !value)} />
      </section>

      <section className="analysis-grid">
        <article className="table-card" id="table">
          <div className="card-heading"><div><span className="chart-label">{year} ranking table</span><h2>{tableExpanded ? `All ranked institutions (${tableRows.length.toLocaleString()})` : 'Leading institutions'}</h2></div><button type="button" className="quiet-button" onClick={() => setTableExpanded((value) => !value)} disabled={!tableRows.length}>{tableExpanded ? 'Show top 5' : 'Full table'} {icon('arrow')}</button></div>
          {tableExpanded && <input ref={searchRef} className="table-search" type="search" value={tableSearch} onChange={(event) => setTableSearch(event.target.value)} placeholder="Search institution, city or state…" aria-label="Search the ranking table" />}
          <div className={`table${tableExpanded ? ' table-scroll' : ''}`}>
            <div className="table-head"><span>Rank</span><span>Institution</span><span>State</span><span>Score</span><span>Category</span></div>
            {visibleRows.map((row, index) => <div className="table-row" key={`${row.year}-${row.category}-${row.institution_key}-${row.rank_label}`}>
              <span className="rank" title={row.rank_label}>{rankText(row)}</span>
              <div className="institution"><i style={{ background: AVATAR_COLORS[index % AVATAR_COLORS.length] }}>{initials(row.institution)}</i><b title={row.institution}>{row.institution}</b></div>
              <span className="location">{row.state}</span><b>{scoreText(row.score)}</b><span className="rank-change">{row.category}</span>
            </div>)}
            {!visibleRows.length && <div className="empty-state">{tableSearch ? 'No institutions match your search.' : 'No ranked institutions for this selection.'}</div>}
          </div>
        </article>
        <article className="correlation-card">
          <div className="card-heading"><div><span className="chart-label">Parameter explorer</span><h2>What moves together?</h2></div><span className="r-score">r = {isNum(corr) ? corr.toFixed(2) : '—'}</span></div>
          <div className="parameter-selects"><Select label="X axis parameter" value={xKey} onChange={setXKey}>{axisOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</Select><span>vs.</span><Select label="Y axis parameter" value={yKey} onChange={setYKey}>{axisOptions.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</Select></div>
          <ScatterPlot data={correlationRows} xKey={xKey} yKey={yKey} />
          <p className="correlation-note">{isNum(corr) ? <>A <b>{Math.abs(corr) > 0.7 ? 'strong' : Math.abs(corr) > 0.3 ? 'moderate' : 'weak'} {corr >= 0 ? 'positive' : 'negative'}</b> relationship is observed among {correlationRows.length.toLocaleString()} records with both values available.</> : 'Correlation is unavailable because the selected fields do not have enough numeric values or variation.'}</p>
        </article>
      </section>

      <section className="compare-card" id="compare">
        <div className="compare-copy">
          <span className="chart-label">Institution profile</span>
          <h2>Compare performance<br /><em>across every signal.</em></h2>
          <Select label="Institution" value={activeKey} onChange={setInstitutionKey} className="institution-select">{institutionOptions.length === 0 && <option value="">No institutions available</option>}{institutionOptions.map((row) => <option key={row.institution_key} value={row.institution_key}>{row.institution}</option>)}</Select>
          <div className="selected-stats"><span><b>{rankText(selectedRow)}</b>{year} rank</span><span><b>{scoreText(selected.score)}</b>overall score</span></div>
        </div>
        <div className="radar-panel">
          <div><Radar selected={selected} />{selectedRow && !parameters.every((item) => isNum(selected[item.key])) && <p className="radar-note">Parameter scores were not published for this record.</p>}</div>
          <div className="legend">{parameters.map((item) => <span key={item.key}><i style={{ background: item.color }} />{item.full}</span>)}</div>
        </div>
      </section>

      <section className="query-card" id="insights">
        <div className="query-orb" aria-hidden="true">{icon('spark')}</div>
        <div><span className="chart-label">NIRF Copilot · experimental</span><h2>What would you like to understand?</h2><p aria-live="polite">{answer}</p></div>
        <form onSubmit={respond}><input ref={queryRef} className="query-input" value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. Which state has the most institutions?" aria-label="Ask a question about the rankings" /><button type="submit" aria-label="Ask question" disabled={asking}>{icon('send')}</button></form>
        <div className="suggestions"><button type="button" onClick={() => ask('Which state has the most institutions?')}>State representation</button><button type="button" onClick={() => ask('Show research correlation')}>Research correlation</button><button type="button" onClick={() => ask('Show score trend')}>Score trend</button></div>
      </section>

      <footer><span>Source: National Institutional Ranking Framework · prepared records only</span><span>Rule-based Copilot · inspect data/processed/audit_report.json for coverage and gaps</span></footer>
    </main>
  </div>
}

createRoot(document.getElementById('root')).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>)
