// チセさんの生産データ（商品×日付の横持ち表）の共通パース処理。admin.html・cooking.htmlで
// 共通利用する（同じ解析ロジックをページごとに別々に書かない）。
//
// 以前はgviz（docs.google.com/.../gviz/tq）経由でこのシートを読んでいたが、gvizは
// セルの値を列（日付）ごとに多数決で型推定し、少数派の型のセルの値をnullにする仕様がある。
// その列に入っている値の数が少ないと（例：ある土曜列に「具材のみ」の数値が1個だけ、
// 曜日を表す文字セルも1個あるだけ、SUB TOTALも空欄）、本来入っている数値のほうが
// 少数派になってnullとして返ってきてしまい、実際には入っている数が消えて見える不具合が
// あった。そのため読み込みをApps Script（Code.gsのtype=chiseSheet）経由に変更し、
// getDisplayValues()でシート上の表示文字列を型推定無しにそのまま取得する方式にした。
// parseChiseSheetRows()はその文字列の2次元配列を受け取って具材別の個数（数値）に変換する。

// 「具材のみ」の行名（例: "テリヤキ(具材のみ)"）から、対応するおにぎりの具材名
// （例: "テリヤキチキン"）を判定する。全角・半角どちらのカッコ表記にも対応する。
const CHISE_KONOMI_ROW_PATTERN = /[\(（]\s*具材のみ\s*[\)）]/;
const CHISE_KONOMI_ROW_PREFIXES = [
  { prefix: "テリヤキ", filling: "テリヤキチキン" },
  { prefix: "サーモン", filling: "サーモン" },
];
function matchChiseKonomiFilling(rawName){
  if(!CHISE_KONOMI_ROW_PATTERN.test(rawName)) return null;
  const match = CHISE_KONOMI_ROW_PREFIXES.find(p => rawName.startsWith(p.prefix));
  return match ? match.filling : null;
}

// Code.gs(type=chiseSheet)が返す表示値の2次元配列（すべて文字列）を解析し、
// "M/D" -> { breakdown, konomiBreakdown, subtotal } のマップを返す。
//   breakdown: おにぎり本体の個数（"○○(具材のみ)"の行は含まない）
//   konomiBreakdown: "○○(具材のみ)"の行だけの個数
//   subtotal: breakdownの合計（具材のみを含まない、おにぎりの個数としての「チセ分」）
// シート上のSUB TOTAL列の数式は具材のみの分も合算されているため、SUB TOTAL自体は使わない
// （admin.html側の「チセ分」・販売計・総生産数・本部の数は、常にこのsubtotalを使う）。
// 日付ヘッダは「11/7」のような単純な表記に加え、土曜列などで「11/7(土)」のように曜日表記が
// 付いている場合があるため、先頭の"M/D"部分だけを日付として読み取る（末尾は無視する）。
// 具材のみは、SUB TOTALの有無・値に関係なく、該当する行に数字が入っていれば必ず読む
// （空欄は0として扱う）。
function parseChiseSheetRows(rows){
  const result = {};
  if(!rows || rows.length === 0) return result;

  const dateHeaderRow = rows[0] || [];
  const dateCols = [];
  dateHeaderRow.forEach((text, idx) => {
    const m = text && String(text).match(/^(\d{1,2}\/\d{1,2})/);
    if(m) dateCols.push({ idx, label: m[1] });
  });

  const cellLabel = v => (v === null || v === undefined) ? "" : String(v).trim();
  let startRow = -1, endRow = -1;
  rows.forEach((r, i) => {
    if(cellLabel(r[0]) === "商品") startRow = i + 1;
    if(cellLabel(r[0]) === "SUB TOTAL" && startRow !== -1 && endRow === -1) endRow = i;
  });
  if(startRow === -1 || endRow === -1) return result;

  // 表示文字列を数値に変換する。空欄は0、数値化できない文字列も0として扱う
  // （getDisplayValues()で取得した文字列には型推定による欠落が無いため、
  // 「数字が入っていれば必ず読む」をそのまま実装できる）
  const toNumber = str => {
    const s = cellLabel(str).replace(/,/g, "");
    if(s === "") return 0;
    const n = Number(s);
    return isNaN(n) ? 0 : n;
  };

  dateCols.forEach(({ idx, label }) => {
    const breakdown = {};
    const konomiBreakdown = {};
    for(let i = startRow; i < endRow; i++){
      const name = cellLabel(rows[i][0]);
      if(!name) continue;
      const qty = toNumber(rows[i][idx]);
      const konomiFilling = matchChiseKonomiFilling(name);
      if(konomiFilling) konomiBreakdown[konomiFilling] = (konomiBreakdown[konomiFilling] || 0) + qty;
      else breakdown[name] = (breakdown[name] || 0) + qty;
    }
    const subtotal = Object.values(breakdown).reduce((s, v) => s + v, 0);
    result[label] = { breakdown, konomiBreakdown, subtotal };
  });
  return result;
}

// Code.gs(type=chiseSheet)からチセさんシートの表示値（2次元配列）を取得し、解析済みの
// マップを返す。取得に失敗した場合は空のマップを返す（呼び出し側のtrackFetchResult等で
// 失敗を扱えるよう、生の行データが必要な場合はfetchChiseSheetRowsを個別に呼ぶこと）。
async function fetchChiseSheetRows(scriptUrl){
  const res = await fetch(`${scriptUrl}?type=chiseSheet`, { cache: "no-store" });
  const json = await res.json();
  if(json && json.error) throw new Error(json.error);
  return json.rows || [];
}
