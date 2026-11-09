// 正例（審查意見）：型別欄位叫 animation、文案裡有 transition，都不是轉場；沒有 reduced-motion 也不該報
export interface Clip { animation: string; transitionNote: string }
export const copy = 'A smooth transition between seasons'
