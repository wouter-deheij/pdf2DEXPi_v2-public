// Apple Vision OCR: prints one JSON line per image with every recognised text line and its
// pixel box (origin top-left). With --rotate also reads the image turned 90° for vertical text.
// usage: vision_ocr [--rotate] img1.png img2.png ...
import Foundation
import Vision
import AppKit

struct Token: Codable { let text: String; let conf: Float; let box: [Double]; let vertical: Bool }
struct Out: Codable { let image: String; let width: Int; let height: Int; let tokens: [Token] }

func recognise(_ cg: CGImage) -> [VNRecognizedTextObservation] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.minimumTextHeight = 0.004
    let h = VNImageRequestHandler(cgImage: cg, options: [:])
    try? h.perform([req])
    return req.results ?? []
}

func rotated90(_ cg: CGImage, ccw: Bool = false) -> CGImage? {
    let w = cg.width, h = cg.height
    guard let ctx = CGContext(data: nil, width: h, height: w, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    if ccw {
        ctx.translateBy(x: CGFloat(h), y: 0)
        ctx.rotate(by: .pi / 2)
    } else {
        ctx.translateBy(x: 0, y: CGFloat(w))
        ctx.rotate(by: -.pi / 2)
    }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}

var args = Array(CommandLine.arguments.dropFirst())
let rotate = args.contains("--rotate")
args.removeAll { $0 == "--rotate" }
let enc = JSONEncoder()
for path in args {
    guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!); continue
    }
    let W = Double(cg.width), H = Double(cg.height)
    var tokens: [Token] = []
    for o in recognise(cg) {
        guard let c = o.topCandidates(1).first else { continue }
        let b = o.boundingBox
        tokens.append(Token(text: c.string, conf: c.confidence,
                            box: [b.minX * W, (1 - b.maxY) * H, b.maxX * W, (1 - b.minY) * H], vertical: false))
    }
    if rotate, let r = rotated90(cg) {
        // rotated image is H wide, W high; map back: x = W*(1-v_y)… derived from the clockwise rotation
        for o in recognise(r) {
            guard let c = o.topCandidates(1).first else { continue }
            let b = o.boundingBox // normalised in rotated frame (origin bottom-left)
            // rotated pixel coords (top-left origin): rx = b.x*H, ry = (1-b.y)*W
            let rx0 = b.minX * H, rx1 = b.maxX * H
            let ry0 = (1 - b.maxY) * W, ry1 = (1 - b.minY) * W
            // inverse of clockwise rotation: x = W - ry, y = rx
            // genuine vertical text maps to a tall box; wide boxes are sideways re-reads of horizontal text
            if (rx1 - rx0) <= (ry1 - ry0) { continue }
            tokens.append(Token(text: c.string, conf: c.confidence,
                                box: [W - ry1, rx0, W - ry0, rx1], vertical: true))
        }
    }
    if rotate, let r = rotated90(cg, ccw: true) {
        for o in recognise(r) {
            guard let c = o.topCandidates(1).first else { continue }
            let b = o.boundingBox
            let rx0 = b.minX * H, rx1 = b.maxX * H
            let ry0 = (1 - b.maxY) * W, ry1 = (1 - b.minY) * W
            if (rx1 - rx0) <= (ry1 - ry0) { continue }
            // inverse of the other rotation: x = ry, y = H - rx
            tokens.append(Token(text: c.string, conf: c.confidence,
                                box: [ry0, H - rx1, ry1, H - rx0], vertical: true))
        }
    }
    let out = Out(image: path, width: cg.width, height: cg.height, tokens: tokens)
    if let d = try? enc.encode(out), let s = String(data: d, encoding: .utf8) { print(s) }
}
