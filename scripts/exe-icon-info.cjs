#!/usr/bin/env node
/**
 * exe-icon-info.cjs -- dump the icon resources embedded in a PE file.
 *
 * Reports both resource types the shell cares about:
 *   RT_ICON (3)        -- the raw icon images (BMP DIB or PNG bytes)
 *   RT_GROUP_ICON (14) -- the ICONDIR/ICONDIRENTRY table that names them
 *
 * For each group it cross-checks that every ICONDIRENTRY points at a real
 * RT_ICON id (a dangling group entry is a broken resource table).
 *
 * Usage: node scripts/exe-icon-info.cjs <file.exe> [...more.exe]
 */

"use strict";

const fs = require("node:fs");

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

function readSections(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error("not a PE file");
  const numSec = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  const is64 = magic === 0x20b;
  const dirsOff = optOff + (is64 ? 112 : 96);
  const rsrcRva = buf.readUInt32LE(dirsOff + 2 * 8);
  const secOff = optOff + optSize;
  const sections = [];
  for (let i = 0; i < numSec; i++) {
    const off = secOff + i * 40;
    sections.push({
      name: buf.toString("ascii", off, off + 8).replace(/\0+$/, ""),
      vsize: buf.readUInt32LE(off + 8),
      vaddr: buf.readUInt32LE(off + 12),
      rawsize: buf.readUInt32LE(off + 16),
      rawptr: buf.readUInt32LE(off + 20),
    });
  }
  return {sections, rsrcRva};
}

function rvaToRaw(sections, rva) {
  for (const s of sections) {
    const span = Math.max(s.vsize, s.rawsize);
    if (rva >= s.vaddr && rva < s.vaddr + span) return s.rawptr + (rva - s.vaddr);
  }
  return null;
}

/** Walk the resource directory root, returning type/id/langlevel triples. */
function walkResources(buf, sections, rsrcRva) {
  const base = rvaToRaw(sections, rsrcRva);
  if (base == null) throw new Error("resource RVA not mapped");
  const out = [];

  const readDir = (dirOff) => {
    const named = buf.readUInt16LE(dirOff + 12);
    const ids = buf.readUInt16LE(dirOff + 14);
    const entries = [];
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8;
      entries.push({
        id: buf.readUInt32LE(e),
        nameIsString: (buf.readUInt32LE(e) & 0x80000000) !== 0,
        offset: buf.readUInt32LE(e + 4),
        isDir: (buf.readUInt32LE(e + 4) & 0x80000000) !== 0,
      });
    }
    return entries;
  };

  for (const typeEnt of readDir(base)) {
    if (typeEnt.nameIsString || !typeEnt.isDir) continue;
    const type = typeEnt.id & 0xffff;
    for (const nameEnt of readDir(base + (typeEnt.offset & 0x7fffffff))) {
      if (nameEnt.nameIsString || !nameEnt.isDir) continue;
      const nameId = nameEnt.id & 0xffff;
      for (const langEnt of readDir(base + (nameEnt.offset & 0x7fffffff))) {
        const lang = langEnt.id & 0xffff;
        if (langEnt.isDir) continue;
        const dataEntOff = base + langEnt.offset;
        const dataRva = buf.readUInt32LE(dataEntOff);
        const dataSize = buf.readUInt32LE(dataEntOff + 4);
        const dataRaw = rvaToRaw(sections, dataRva);
        if (dataRaw == null) continue;
        out.push({type, nameId, lang, dataRaw, dataSize});
      }
    }
  }
  return out;
}

/** Describe one RT_ICON payload: BMP DIB header or PNG. */
function describeIconPayload(buf, raw, size) {
  const isPng =
    size >= 8 &&
    buf[raw] === 0x89 &&
    buf.toString("ascii", raw + 1, raw + 4) === "PNG";
  if (isPng) {
    const w = buf.readUInt32BE(raw + 16);
    const h = buf.readUInt32BE(raw + 20);
    const bitDepth = buf[raw + 24];
    const colorType = buf[raw + 25];
    return {
      kind: "PNG",
      w,
      h,
      detail: `bitDepth=${bitDepth} colorType=${colorType}`,
    };
  }
  const biSize = buf.readUInt32LE(raw);
  const biWidth = buf.readInt32LE(raw + 4);
  const biHeight = buf.readInt32LE(raw + 8);
  const biBitCount = buf.readUInt16LE(raw + 14);
  const biCompression = buf.readUInt32LE(raw + 16);
  const biSizeImage = buf.readUInt32LE(raw + 20);
  // 一致性：DIB 头声明的图像区（XOR+AND）必须等于实际载荷 - 40 字节头。
  // 若掩码被截断，biSizeImage 就会与实际载荷长度对不上（资源表不自洽）。
  const claimed = 40 + biSizeImage;
  return {
    kind: "BMP",
    w: biWidth,
    h: biHeight / 2,
    size,
    biSizeImage,
    consistent: claimed === size,
    detail: `biSize=${biSize} biHeight=${biHeight} bpp=${biBitCount} compression=${biCompression} sizeImage=${biSizeImage} payload=${size} ${claimed === size ? "CONSISTENT" : "*** MISMATCH (header claims " + claimed + " bytes, payload " + size + ") ***"}`,
  };
}

function inspect(file) {
  const buf = fs.readFileSync(file);
  const {sections, rsrcRva} = readSections(buf);
  const res = walkResources(buf, sections, rsrcRva);
  console.log(`\n=== ${file} (${buf.length} bytes) ===`);
  console.log(
    `sections: ${sections.map((s) => s.name).join(",")}  rsrcRva=0x${rsrcRva.toString(16)}`,
  );

  const icons = new Map();
  const groups = [];
  let bad = false;
  for (const r of res) {
    if (r.type === RT_ICON) {
      icons.set(r.nameId, describeIconPayload(buf, r.dataRaw, r.dataSize));
    } else if (r.type === RT_GROUP_ICON) {
      groups.push(r);
    }
  }

  console.log(`RT_ICON resources: ${icons.size}`);
  for (const [id, d] of [...icons.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  id=${id}  ${d.w}x${d.h} ${d.kind} (${d.detail})`);
    if (d.kind === "BMP" && !d.consistent) bad = true;
  }

  for (const g of groups) {
    const declared = buf.readUInt16LE(g.dataRaw + 4);
    console.log(
      `RT_GROUP_ICON id=${g.nameId} lang=0x${g.lang.toString(16)} declared=${declared}`,
    );
    const seen = new Set();
    let ok = true;
    for (let i = 0; i < declared; i++) {
      const e = g.dataRaw + 6 + i * 14;
      const w = buf[e];
      const h = buf[e + 1];
      const bpp = buf.readUInt16LE(e + 6);
      const bytes = buf.readUInt32LE(e + 8);
      const iconId = buf.readUInt16LE(e + 12);
      const present = icons.has(iconId);
      seen.add(iconId);
      if (!present) ok = false;
      const real = icons.get(iconId);
      console.log(
        `   #${i} ${w === 0 ? 256 : w}x${h === 0 ? 256 : h} bpp=${bpp} bytes=${bytes} -> RT_ICON ${iconId} ${present ? "OK" : "*** MISSING ***"}` +
          (real ? ` [${real.kind} ${real.w}x${real.h}]` : ""),
      );
    }
    const orphans = [...icons.keys()].filter((id) => !seen.has(id));
    if (orphans.length) {
      console.log(`   orphan RT_ICONs not in this group: ${orphans.join(",")}`);
      ok = false;
    }
    console.log(`   group ${g.nameId}: ${ok ? "consistent" : "*** INCONSISTENT ***"}`);
  }
  if (!groups.length) console.log("*** no RT_GROUP_ICON resources found ***");
  if (bad)
    console.log("*** BAD: at least one BMP frame has header/payload size mismatch ***");
  return {iconCount: icons.size, groupCount: groups.length, bad};
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: node scripts/exe-icon-info.cjs <file.exe> [...]");
    process.exit(2);
  }
  // 退出码必须反映结果：早先只打印，作为 CI 门禁时永远是「通过」。
  let failures = 0;
  for (const f of files) {
    try {
      const result = inspect(f);
      if (result.bad || result.iconCount === 0) failures += 1;
    } catch (error) {
      console.error(`${f}: ${error.message}`);
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(`exe-icon-info: ${failures} file(s) failed`);
    process.exitCode = 1;
  }
}
