/**
 * Recent-JS shims for old WebViews. Plain JS, no imports, no side effects
 * beyond defining what is missing.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM main.ts:
 * a Web Worker is its own JS realm. pdf.js does most of its work in one, so
 * polyfills installed on the main thread are invisible to it — the failure
 * looks like a document that opens forever with no error on the page, while
 * logcat quietly reports "Promise.try is not a function" from pdf.worker.js.
 * vite.config.ts injects this same file as the worker bundle's banner, so
 * both realms get one source of truth.
 *
 * Why any of it is needed: Android's System WebView updates through the Play
 * Store, so an app can land on a browser years behind the phone. pdf.js 5.x
 * reaches for APIs from Chrome 117–128; a WebView 113 device failed on
 * Promise.withResolvers, then URL.parse, then Promise.try — one shim at a
 * time, each looking like a different bug.
 */

// Promise.withResolvers — Chrome 119
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// Promise.try — Chrome 128. Runs fn synchronously, always returns a promise.
if (typeof Promise.try !== 'function') {
  Promise.try = function (fn, ...args) {
    return new Promise((resolve) => resolve(fn(...args)))
  }
}

// URL.parse / URL.canParse — Chrome 126. Return null instead of throwing.
if (typeof URL.parse !== 'function') {
  URL.parse = function (url, base) {
    try {
      return base === undefined ? new URL(url) : new URL(url, base)
    } catch {
      return null
    }
  }
}
if (typeof URL.canParse !== 'function') {
  URL.canParse = function (url, base) {
    return URL.parse(url, base) !== null
  }
}

// Object.groupBy / Map.groupBy — Chrome 117
if (typeof Object.groupBy !== 'function') {
  Object.groupBy = function (items, key) {
    const out = Object.create(null)
    let i = 0
    for (const item of items) {
      const k = key(item, i++)
      ;(out[k] ??= []).push(item)
    }
    return out
  }
}
if (typeof Map.groupBy !== 'function') {
  Map.groupBy = function (items, key) {
    const out = new Map()
    let i = 0
    for (const item of items) {
      const k = key(item, i++)
      const list = out.get(k)
      if (list) list.push(item)
      else out.set(k, [item])
    }
    return out
  }
}

// Iterator helpers — Chrome 122 / Safari 18.4. pdf.js 5.x calls
// `map.keys().find(...)` inside its range-transport code, so on an older
// engine every chunked read throws "keys(...).find is not a function" and the
// document never finishes loading. Installing them on %IteratorPrototype%
// covers every built-in iterator at once.
;(function installIteratorHelpers() {
  const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))
  if (!IteratorPrototype || typeof IteratorPrototype.find === 'function') return

  const define = (name, fn) => {
    if (typeof IteratorPrototype[name] !== 'function') {
      Object.defineProperty(IteratorPrototype, name, {
        value: fn,
        writable: true,
        configurable: true,
        enumerable: false,
      })
    }
  }

  define('find', function (predicate) {
    let i = 0
    for (const value of this) if (predicate(value, i++)) return value
    return undefined
  })
  define('some', function (predicate) {
    let i = 0
    for (const value of this) if (predicate(value, i++)) return true
    return false
  })
  define('every', function (predicate) {
    let i = 0
    for (const value of this) if (!predicate(value, i++)) return false
    return true
  })
  define('forEach', function (fn) {
    let i = 0
    for (const value of this) fn(value, i++)
  })
  define('reduce', function (fn, ...initial) {
    let acc
    let i = 0
    let seeded = initial.length > 0
    if (seeded) acc = initial[0]
    for (const value of this) {
      if (!seeded) { acc = value; seeded = true; i++; continue }
      acc = fn(acc, value, i++)
    }
    if (!seeded) throw new TypeError('reduce of empty iterator with no initial value')
    return acc
  })
  define('toArray', function () {
    return [...this]
  })
  define('map', function (fn) {
    const source = this
    return (function* () {
      let i = 0
      for (const value of source) yield fn(value, i++)
    })()
  })
  define('filter', function (predicate) {
    const source = this
    return (function* () {
      let i = 0
      for (const value of source) if (predicate(value, i++)) yield value
    })()
  })
  define('take', function (limit) {
    const source = this
    return (function* () {
      let n = 0
      if (limit <= 0) return
      for (const value of source) {
        yield value
        if (++n >= limit) return
      }
    })()
  })
  define('drop', function (count) {
    const source = this
    return (function* () {
      let n = 0
      for (const value of source) {
        if (n++ < count) continue
        yield value
      }
    })()
  })
  define('flatMap', function (fn) {
    const source = this
    return (function* () {
      let i = 0
      for (const value of source) yield* fn(value, i++)
    })()
  })
})()

// Uint8Array base64/hex — very recent (Chrome 140-ish). pdf.js 5.x calls
// bytes.toHex() when it builds object ids, which failed here as the
// delightfully opaque "i.toHex is not a function".
;(function installBytesCodecs() {
  const P = typeof Uint8Array === 'function' ? Uint8Array.prototype : null
  if (!P) return
  const HEX = '0123456789abcdef'

  if (typeof P.toHex !== 'function') {
    P.toHex = function () {
      let out = ''
      for (let i = 0; i < this.length; i++) {
        out += HEX[this[i] >> 4] + HEX[this[i] & 15]
      }
      return out
    }
  }
  if (typeof Uint8Array.fromHex !== 'function') {
    Uint8Array.fromHex = function (hex) {
      if (hex.length % 2) throw new SyntaxError('odd-length hex string')
      const out = new Uint8Array(hex.length / 2)
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      }
      return out
    }
  }
  if (typeof P.toBase64 !== 'function') {
    P.toBase64 = function () {
      let bin = ''
      // chunked: String.fromCharCode(...huge) blows the argument limit
      for (let i = 0; i < this.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000))
      }
      return btoa(bin)
    }
  }
  if (typeof Uint8Array.fromBase64 !== 'function') {
    Uint8Array.fromBase64 = function (text) {
      const bin = atob(text)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    }
  }
})()

// Map/WeakMap upsert — Chrome 143, i.e. bleeding edge at time of writing.
// pdf.js 5.7 calls getOrInsertComputed inside its page cache; without it
// every page render fails with "this[#e].getOrInsertComputed is not a
// function" and you get correctly sized, entirely blank pages.
;(function installUpsert() {
  for (const Ctor of [typeof Map === 'function' ? Map : null, typeof WeakMap === 'function' ? WeakMap : null]) {
    if (!Ctor) continue
    const P = Ctor.prototype
    if (typeof P.getOrInsert !== 'function') {
      P.getOrInsert = function (key, value) {
        if (this.has(key)) return this.get(key)
        this.set(key, value)
        return value
      }
    }
    if (typeof P.getOrInsertComputed !== 'function') {
      P.getOrInsertComputed = function (key, callback) {
        if (this.has(key)) return this.get(key)
        const value = callback(key)
        this.set(key, value)
        return value
      }
    }
  }
})()

// Math.sumPrecise — Chrome 134. pdf.js catches the failure and falls back,
// so this one only ever showed up as a console warning — but the fallback is
// a plain sum, and this function exists precisely because plain summation
// drifts. Cheap to provide properly.
if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = function (values) {
    // Neumaier compensated summation: Kahan's variant that also handles the
    // case where the running total is smaller than the incoming term
    let sum = 0
    let compensation = 0
    for (const raw of values) {
      const value = Number(raw)
      const t = sum + value
      compensation += Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum
      sum = t
    }
    return sum + compensation
  }
}

// ArrayBuffer transfer — Chrome 114, one version above the WebView that
// found all of this. pdf.js swallows the failure ("ignoring errors during
// GetOperatorList"), so pages still draw but with pieces missing — the worst
// kind of breakage, because nothing looks wrong until content is absent.
// A real transfer detaches the source; a copy cannot, but it is correct for
// every caller that only wants the bytes at a fixed length.
;(function installArrayBufferTransfer() {
  const P = typeof ArrayBuffer === 'function' ? ArrayBuffer.prototype : null
  if (!P) return
  const copyTo = (buffer, newLength) => {
    const length = newLength === undefined ? buffer.byteLength : newLength
    const out = new ArrayBuffer(length)
    new Uint8Array(out).set(new Uint8Array(buffer, 0, Math.min(length, buffer.byteLength)))
    return out
  }
  if (typeof P.transfer !== 'function') {
    P.transfer = function (newLength) {
      return copyTo(this, newLength)
    }
  }
  if (typeof P.transferToFixedLength !== 'function') {
    P.transferToFixedLength = function (newLength) {
      return copyTo(this, newLength)
    }
  }
})()

// ReadableStream async iteration — still missing in WebKit, which pdf.js
// uses inside getTextContent(). Without it the text layer and form layer
// silently die IN THE NATIVE APP ONLY (Chromium has the API, so browser
// E2E passes).
if (typeof ReadableStream !== 'undefined' && !(Symbol.asyncIterator in ReadableStream.prototype)) {
  ReadableStream.prototype[Symbol.asyncIterator] = function () {
    const reader = this.getReader()
    return {
      next: () => reader.read(),
      return: (value) => {
        reader.releaseLock()
        return Promise.resolve({ done: true, value })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
}
