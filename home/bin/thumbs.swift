// thumbs.swift — 把一批圖排成一張縮圖總表（PNG），給 home/bin/thumbs 用（2026-10-21）。
//
//   thumbs-bin <輸出.png> <格子邊長px> <欄數> <圖檔...>
//
// 只用 AppKit，不裝 Pillow／ImageMagick（這台的 python3 沒有 PIL）。
// 放大用最近鄰（像素圖不糊）、縮小用平滑；透明的地方墊棋盤格，看得出 sprite 的邊。
// 讀不到的檔印到 stderr 並畫成紅框，不默默跳過。
import AppKit

let args = CommandLine.arguments
guard args.count >= 5, let cell = Int(args[2]), let cols = Int(args[3]), cell > 0, cols > 0 else {
    FileHandle.standardError.write("用法：thumbs-bin <輸出.png> <格子邊長px> <欄數> <圖檔...>\n".data(using: .utf8)!)
    exit(2)
}
let out = args[1]
let files = Array(args[4...])

let pad = 8
let labelH = 18
let rows = (files.count + cols - 1) / cols
let W = cols * (cell + pad) + pad
let H = rows * (cell + labelH + pad) + pad

guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H,
                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let ctx = NSGraphicsContext(bitmapImageRep: rep) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = ctx

// AppKit 的原點在左下。排版用「從上往下」的 y，畫之前經 up() 換回去
// （不用翻轉座標：翻轉過的座標裡文字會跟著倒過來）
func up(_ top: Int, _ h: Int) -> Int { H - top - h }

NSColor(white: 0.12, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: W, height: H).fill()

let labelAttrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
    .foregroundColor: NSColor(white: 0.85, alpha: 1),
]
var failed = 0

for (i, path) in files.enumerated() {
    let x = pad + (i % cols) * (cell + pad)
    let y = pad + (i / cols) * (cell + labelH + pad)
    let box = NSRect(x: x, y: up(y, cell), width: cell, height: cell)

    // 棋盤格
    let sq = 8
    for cy in stride(from: 0, to: cell, by: sq) {
        for cx in stride(from: 0, to: cell, by: sq) {
            ((cx / sq + cy / sq) % 2 == 0 ? NSColor(white: 0.22, alpha: 1) : NSColor(white: 0.28, alpha: 1)).setFill()
            let h = min(sq, cell - cy)
            NSRect(x: x + cx, y: up(y + cy, h), width: min(sq, cell - cx), height: h).fill()
        }
    }

    let name = (path as NSString).lastPathComponent
    if let img = NSImage(contentsOfFile: path), let src = img.representations.first,
       src.pixelsWide > 0, src.pixelsHigh > 0 {
        let pw = CGFloat(src.pixelsWide), ph = CGFloat(src.pixelsHigh)
        var s = min(CGFloat(cell) / pw, CGFloat(cell) / ph)
        if s >= 1 { s = floor(s) }  // 整數倍放大，像素才不會一格寬一格窄
        let dw = pw * s, dh = ph * s
        let dst = NSRect(x: box.minX + (CGFloat(cell) - dw) / 2, y: box.minY + (CGFloat(cell) - dh) / 2,
                         width: dw, height: dh)
        ctx.imageInterpolation = s >= 1 ? .none : .high
        img.draw(in: dst, from: .zero, operation: .sourceOver, fraction: 1)
    } else {
        failed += 1
        FileHandle.standardError.write("讀不到：\(path)\n".data(using: .utf8)!)
        NSColor.systemRed.setStroke()
        let p = NSBezierPath(rect: box.insetBy(dx: 1, dy: 1)); p.lineWidth = 2; p.stroke()
    }

    // 檔名太長就留頭尾
    var label = name
    let maxChars = max(4, cell / 7)
    if label.count > maxChars {
        let keep = (maxChars - 1) / 2
        label = String(label.prefix(keep)) + "…" + String(label.suffix(maxChars - 1 - keep))
    }
    (label as NSString).draw(at: NSPoint(x: x, y: up(y + cell + 2, 14)), withAttributes: labelAttrs)
}

NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
do { try png.write(to: URL(fileURLWithPath: out)) } catch {
    FileHandle.standardError.write("寫不出 \(out)：\(error)\n".data(using: .utf8)!)
    exit(1)
}
exit(failed == files.count ? 1 : 0)
