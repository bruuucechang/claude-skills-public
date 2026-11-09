// 正例：註解裡的 #ffffff、emoji 🚀、王小明 都不算；⚠ ◀ ☀ ✓ 是文字符號，不算 emoji
export default function App() {
  const anchor = '#top'
  return <main className="card"><h1>收成紀錄</h1><p className="warn">⚠ 資料晚了一天</p><a href={anchor}>回到頂端 ✓</a><p>&#169; 2026</p></main>
}
