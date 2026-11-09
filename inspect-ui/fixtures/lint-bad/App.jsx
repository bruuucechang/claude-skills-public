// 反例：source-lint 的每一條都要抓到（第一行是註解，裡面的 #ffffff 不算）
export default function App() {
  return (
    <div style={{ color: '#3b82f6', minHeight: '100vh' }}>
      <h1>🚀 客戶清單</h1>
      <p>王小明 · 0912-345-678</p>
      <p>Lorem ipsum dolor sit amet</p>
      <button className="transition-all bg-[#1a2b3c]">儲存</button>
    </div>
  )
}
