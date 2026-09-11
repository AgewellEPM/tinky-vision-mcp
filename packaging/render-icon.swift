import AppKit
import Foundation

// A code-generated project mark; no screen capture or external image inputs.
let size = 512
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedRed: 0.04, green: 0.08, blue: 0.15, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 512, height: 512), xRadius: 110, yRadius: 110).fill()
NSColor(calibratedRed: 0.27, green: 0.91, blue: 0.77, alpha: 1).setStroke()
let frame = NSBezierPath(roundedRect: NSRect(x: 80, y: 120, width: 352, height: 272), xRadius: 45, yRadius: 45)
frame.lineWidth = 18
frame.stroke()
NSColor.white.setFill()
NSBezierPath(roundedRect: NSRect(x: 144, y: 288, width: 224, height: 30), xRadius: 12, yRadius: 12).fill()
NSBezierPath(roundedRect: NSRect(x: 241, y: 185, width: 30, height: 120), xRadius: 12, yRadius: 12).fill()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
