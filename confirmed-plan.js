// 「確定プラン」シートの共通パース処理。admin.html・index.html・cooking.htmlで共通利用する
// （同じ確定プランの読み取りロジックをページごとに別々に書かない）。
//
// 確定プランシートの列（0始まり）：
//   0:日付 1:曜日 2:Zuid確定数 3:UvA確定数 4:チセ分 5:ニギニギ隊内訳 6:本部製造数 7:本部内訳
//   8:確定日時 9:Zuid内訳 10:UvA内訳 11:チセ内訳 12:修正日時
// 9〜11（具材別の内訳）は後から追加した列のため、古い確定行には無い場合がある
// （hasDetailBreakdownで判定する）。
// 12（修正日時）は、確定後にadmin.htmlの「この日を修正する」で内容を上書き公開した場合のみ
// 書き込まれる（初回確定時は空のまま）。空ならその日はまだ一度も修正されていない。

// "ツナマヨ×14 テリヤキチキン×25" 形式の文字列を {具材名: 個数} にパースする。
// 内訳に無い具材は含めない（0埋めはしない。呼び出し側で `|| 0` で参照すること）。
function parseFillingBreakdownString(str){
  const result = {};
  if(!str) return result;
  String(str).trim().split(/\s+/).filter(Boolean).forEach(part => {
    const [filling, qtyStr] = part.split("×");
    if(filling) result[filling] = parseInt(qtyStr, 10) || 0;
  });
  return result;
}

// "名前:具材×個数 具材×個数；名前:..." 形式の文字列を {名前: {具材名: 個数}} にパースする
function parseNingiBreakdownToMemberFillingQty(str){
  const result = {};
  if(!str) return result;
  String(str).split("；").filter(Boolean).forEach(part => {
    const idx = part.indexOf(":");
    if(idx === -1) return;
    const name = part.slice(0, idx).trim();
    if(!name) return;
    result[name] = parseFillingBreakdownString(part.slice(idx + 1));
  });
  return result;
}

// 「確定プラン」シートのgvizレスポンスを "M/D" -> 確定内容 のマップにパースする。
// 確定済みかどうか・確定内容は、この結果（スプレッドシートの内容）を正とする。
function parseConfirmedPlansSheet(json){
  const result = {};
  if(!json || !json.table || !json.table.rows) return result;
  json.table.rows.forEach(r => {
    const c = r.c;
    if(!c || !c[0]) return;
    const key = String((c[0] && (c[0].f || c[0].v)) || "").trim();
    if(!key) return;
    const memberFillingQty = parseNingiBreakdownToMemberFillingQty(c[5] ? c[5].v : "");
    const zuidBreakdown = parseFillingBreakdownString(c[9] ? c[9].v : "");
    const uvaBreakdown = parseFillingBreakdownString(c[10] ? c[10].v : "");
    const chiseBreakdown = parseFillingBreakdownString(c[11] ? c[11].v : "");
    result[key] = {
      zuid: c[2] && c[2].v !== null && c[2].v !== "" ? Number(c[2].v) : 0,
      uva: c[3] && c[3].v !== null && c[3].v !== "" ? Number(c[3].v) : 0,
      chise: c[4] && c[4].v !== null && c[4].v !== "" ? Number(c[4].v) : 0,
      memberNames: Object.keys(memberFillingQty),
      memberFillingQty,
      hqQty: c[6] && c[6].v !== null && c[6].v !== "" ? Number(c[6].v) : 0,
      hqBreakdown: parseFillingBreakdownString(c[7] ? c[7].v : ""),
      confirmedAtLabel: c[8] ? String(c[8].f || c[8].v || "") : "",
      // 確定日時の生値（gvizの"Date(y,m,d,h,mi,s)"形式等）。保存直前の楽観的ロック確認用。
      confirmedAtRaw: c[8] && c[8].v !== null && c[8].v !== undefined ? String(c[8].v) : "",
      zuidBreakdown, uvaBreakdown, chiseBreakdown,
      // Zuid/UvA/チセ内訳列は後から追加した列のため、古い確定行には無い場合がある。
      // その場合は具材別の数字を確定プランから取れないため、呼び出し側は
      // 作業中プラン等へのフォールバックを判断する
      hasDetailBreakdown: !!(c[9] && c[9].v) || !!(c[10] && c[10].v) || !!(c[11] && c[11].v),
      // 確定後に「この日を修正する」で内容を公開した場合のみ入る（未修正なら空文字）
      revisedAtLabel: c[12] ? String(c[12].f || c[12].v || "") : "",
    };
  });
  return result;
}
