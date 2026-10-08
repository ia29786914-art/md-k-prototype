# -*- coding: utf-8 -*-
"""
MD-K 數據自動更新腳本（GitHub Actions 定時運行）

數據源：
- 恒指 + 12 隻權重股：Yahoo Finance chart API（與原始快照同源）
- 南向淨買入：東方財富 RPT_MUTUAL_DEAL_HISTORY，MUTUAL_TYPE 002+004 之和（百萬港元）

輸出：data.js / breadth.js / southflow.js，並同步更新 index.html 的日期標記。
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (顯示名, Yahoo 代碼, 靜態權重%) —— 12 隻權重股，合計約 56%
STOCKS = [
    ("騰訊",   "0700.HK", 8.0),
    ("阿里",   "9988.HK", 7.5),
    ("美團",   "3690.HK", 5.0),
    ("匯豐",   "0005.HK", 7.5),
    ("友邦",   "1299.HK", 5.5),
    ("建行",   "0939.HK", 4.5),
    ("中移動", "0941.HK", 3.5),
    ("中海油", "0883.HK", 3.5),
    ("小米",   "1810.HK", 3.2),
    ("港交所", "0388.HK", 2.8),
    ("平保",   "2318.HK", 2.5),
    ("工行",   "1398.HK", 2.5),
]
START = 1575158400  # 2019-12-01，留 buffer 讓 2020-01-02 有前收盤價
TODAY = int(datetime.now(timezone.utc).timestamp())


def fetch_json(url, retries=4):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"fetch failed: {url}\n{last}")


def yahoo_daily(symbol, p1=START, p2=TODAY):
    u = ("https://query1.finance.yahoo.com/v8/finance/chart/"
         + urllib.parse.quote(symbol, safe="")
         + f"?period1={p1}&period2={p2}&interval=1d&events=history")
    d = fetch_json(u)
    res = (d.get("chart") or {}).get("result") or []
    if not res:
        raise RuntimeError(f"no data for {symbol}: {str(d)[:300]}")
    res = res[0]
    ts = res.get("timestamp") or []
    q = (res.get("indicators") or {}).get("quote") or [{}]
    q = q[0]
    out = []
    trailing_null_dates = []
    for i, t in enumerate(ts):
        dt = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
        c = (q.get("close") or [None] * len(ts))[i]
        if c is None:
            if out:  # 只處理尾部未填充的 bar（歷史空洞直接跳過）
                trailing_null_dates.append(dt)
            continue
        out.append([
            dt,
            q["open"][i],
            q["high"][i],
            q["low"][i],
            c,
            int(q["volume"][i]) if q.get("volume") and q["volume"][i] is not None else 0,
        ])
    # Yahoo 日線偶爾滯後：最近交易日已收市但日線 bar 還是 null。
    # 用小時線聚合補上；量為 0 時用近 20 日非零中位數暫代（下次運行會自動修正）。
    if trailing_null_dates:
        hb = hourly_aggregates(symbol)
        recent_vols = sorted(r[5] for r in out[-25:] if r[5] > 0)
        med_vol = recent_vols[len(recent_vols) // 2] if recent_vols else 0
        for dt in trailing_null_dates:
            if dt in hb:
                o, h, l, c, v = hb[dt]
                if v == 0:
                    v = med_vol
                    print(f"  WARNING: {symbol} {dt} 量能缺失，暫以近20日中位數 {v} 代替（下次運行修正）")
                else:
                    print(f"  NOTE: {symbol} {dt} 日線未填充，已用小時線聚合補上")
                out.append([dt, o, h, l, c, v])
        out.sort(key=lambda r: r[0])
    return out


def hourly_aggregates(symbol):
    """用 1h K 線把最近幾天聚合成日線 OHLCV（Yahoo 日線滯後時的後備）。"""
    u = ("https://query1.finance.yahoo.com/v8/finance/chart/"
         + urllib.parse.quote(symbol, safe="") + "?range=5d&interval=1h")
    try:
        d = fetch_json(u)
        res = ((d.get("chart") or {}).get("result") or [None])[0]
        if not res:
            return {}
        q = (res.get("indicators") or {}).get("quote") or [{}]
        q = q[0]
        agg = {}
        for i, t in enumerate(res.get("timestamp") or []):
            c = (q.get("close") or [None] * len(res["timestamp"]))[i]
            if c is None:
                continue
            dt = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
            o = q["open"][i]; h = q["high"][i]; l = q["low"][i]
            v = q.get("volume") or [0] * len(res["timestamp"])
            v = int(v[i] or 0)
            if dt not in agg:
                agg[dt] = [o, h, l, c, v]
            else:
                a = agg[dt]
                a[1] = max(a[1], h); a[2] = min(a[2], l); a[3] = c; a[4] += v
        return agg
    except Exception as e:  # noqa: BLE001
        print(f"  WARNING: hourly fallback failed for {symbol}: {e}")
        return {}


def eastmoney_southbound():
    """南向淨買入：MUTUAL_TYPE 002+004（港股通兩個通道），百萬港元。"""
    channels = {}
    for mt in ("002", "004"):
        page, data = 1, {}
        while True:
            qs = urllib.parse.urlencode({
                "reportName": "RPT_MUTUAL_DEAL_HISTORY",
                "columns": "TRADE_DATE,NET_DEAL_AMT",
                "filter": f'(MUTUAL_TYPE="{mt}")(TRADE_DATE>=\'2020-01-01\')',
                "sortColumns": "TRADE_DATE",
                "sortTypes": 1,
                "pageSize": 500,
                "pageNumber": page,
            })
            d = fetch_json("https://datacenter-web.eastmoney.com/api/data/v1/get?" + qs)
            rows = ((d or {}).get("result") or {}).get("data") or []
            for r in rows:
                data[r["TRADE_DATE"][:10]] = r.get("NET_DEAL_AMT")
            if len(rows) < 500:
                break
            page += 1
            if page > 20:
                raise RuntimeError("southbound pagination overflow")
        channels[mt] = data
        print(f"  eastmoney {mt}: {len(data)} rows")
    out = {}
    for dt in set(channels["002"]) | set(channels["004"]):
        a, b = channels["002"].get(dt), channels["004"].get(dt)
        out[dt] = round(a + b, 1) if (a is not None and b is not None) else None
    return out


def dump_js(path, var, rows):
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"const {var} = ")
        f.write(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
        f.write(";\n")
    print(f"  wrote {os.path.basename(path)}: {len(rows)} rows")


def read_existing(path, var):
    try:
        s = open(path, encoding="utf-8").read()
        m = re.search(r"const " + var + r" = (\[.*\]);", s, re.S)
        return json.loads(m.group(1)) if m else None
    except Exception:  # noqa: BLE001
        return None


def main():
    os.chdir(ROOT)

    print("[1/4] fetch ^HSI ...")
    raw = [r for r in yahoo_daily("^HSI") if r[0] >= "2020-01-02"]
    if raw[0][0] != "2020-01-02":
        raise RuntimeError(f"unexpected start date {raw[0][0]}")
    if abs(raw[0][4] - 28543.5) > 2:
        raise RuntimeError(f"2020-01-02 close drifted: {raw[0][4]} (source changed?)")

    # 與庫存數據對齊檢查：重疊區間收盤價偏差須 < 0.5%
    old = read_existing("data.js", "RAW")
    if old:
        old_map = {r[0]: r[4] for r in old}
        overlap = [d for d, *_ in raw if d in old_map][-15:]
        for d in overlap:
            if abs(raw[[r[0] for r in raw].index(d)][4] - old_map[d]) / old_map[d] > 0.005:
                raise RuntimeError(f"overlap mismatch on {d}: new vs old close diverged")
        if raw[-1][0] < old[-1][0]:
            raise RuntimeError(f"new data ends {raw[-1][0]} < existing {old[-1][0]}")
    print(f"  ^HSI: {len(raw)} rows, {raw[0][0]} -> {raw[-1][0]}")

    print("[2/4] fetch 12 stocks & build breadth ...")
    closes = {}
    for name, sym, _w in STOCKS:
        series = yahoo_daily(sym)
        if len(series) < 1500:
            raise RuntimeError(f"{name} {sym}: only {len(series)} rows")
        closes[sym] = {r[0]: r[4] for r in series}
        print(f"  {name} {sym}: {len(series)} rows")

    dates = sorted({d for m in closes.values() for d in m})
    dates = [d for d in dates if d >= raw[0][0]]
    breadth = []
    for d in dates:
        up, total, best_name, best_bp = 0, 0, "—", 0.0
        for name, sym, w in STOCKS:
            c = closes[sym].get(d)
            if c is None:
                continue
            total += 1
            prev_dates = [x for x in closes[sym] if x < d]
            if not prev_dates:
                continue
            pc = closes[sym][prev_dates[-1]]
            chg = (c - pc) / pc * 100
            if chg > 0:
                up += 1
            bp = round(w * chg, 1)
            if abs(bp) > abs(best_bp):
                best_bp, best_name = bp, name
        breadth.append([round(100 * up / 12), up, total, best_name, best_bp])
    print(f"  breadth: {len(breadth)} rows")

    print("[3/4] fetch southbound ...")
    sb = eastmoney_southbound()
    hsi_dates = {r[0] for r in raw}
    sb_rows = [[d, sb.get(d)] for d in sorted(hsi_dates)]
    last_sb = max((d for d, v in sb.items() if v is not None), default="n/a")
    print(f"  southbound: {sum(1 for _, v in sb_rows if v is not None)} trading days, latest {last_sb}")
    if sb.get("2026-09-30") and abs(sb["2026-09-30"] - 6863.6) > 1:
        print(f"  WARNING: 2026-09-30 southbound {sb['2026-09-30']} != snapshot 6863.6")

    print("[4/4] write files ...")
    dump_js("data.js", "RAW", [[d, round(o, 1), round(h, 1), round(l, 1), round(c, 1), v]
                               for d, o, h, l, c, v in raw])
    dump_js("breadth.js", "BREADTH", breadth)
    dump_js("southflow.js", "SB", sb_rows)

    # 同步首頁日期標記
    idx = open("index.html", encoding="utf-8").read()
    idx = re.sub(r"數據截至 \d{4}-\d{2}-\d{2}", f"數據截至 {raw[-1][0]}", idx)
    idx = re.sub(r"恒指日線 \d+ 根，2020-01-02 → \d{4}-\d{2}-\d{2}",
                 f"恒指日線 {len(raw)} 根，2020-01-02 → {raw[-1][0]}", idx)
    idx = re.sub(r"南向資金至 \d{4}-\d{2}-\d{2}", f"南向資金至 {last_sb}", idx)
    with open("index.html", "w", encoding="utf-8") as f:
        f.write(idx)
    print("done.")


if __name__ == "__main__":
    main()
