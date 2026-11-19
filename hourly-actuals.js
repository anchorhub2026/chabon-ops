// 「時間帯別実績」（今日の販売実績）の共通処理。index.html・uva.html・rozen.htmlで
// 共通利用する（売れた数の計算・読み込み・保存の処理を別々に書かない）。
//
// 各ページはこのファイルに加えて、以下を自分で用意する：
//   - FILLINGS（具材名の配列）
//   - SCRIPT_URL（Apps ScriptのWebアプリURL）
// 保存・読み込みは常にCode.gsのtype=hourly（GET）・type=saveHourly（POST）経由で行い、
// 「時間帯別実績」シートの同じ行・同じ列をindex.html/uva.html/rozen.htmlで共有する。

// 時間帯の既定値。「店舗の営業設定」に営業時間の指定が無い場合はこれを使う
// （現時点では「店舗の営業設定」シートに営業時間の列自体が無いため、常にこの既定値になる。
// 将来営業時間の列が追加された場合に備えて、resolveHourlySlots()を呼び出し側に用意している）。
const HOURLY_SLOTS = [12, 13, 14, 15, 16, 17, 18];

// 店舗ごとの時間帯スロットを決める。storeSettings（admin.htmlの「店舗の営業設定」相当、
// 無ければ省略可）にその店舗の営業時間の指定があれば使い、無ければHOURLY_SLOTSを返す。
function resolveHourlySlots(storeKey, storeSettings){
  const config = storeSettings && storeSettings[storeKey];
  if(config && Array.isArray(config.hourlySlots) && config.hourlySlots.length > 0){
    return config.hourlySlots;
  }
  return HOURLY_SLOTS;
}

// 確定プラン（confirmed-plan.jsのparseConfirmedPlansSheet()が返すオブジェクト）から、
// 具材ごとの合計個数を{具材名: 個数}の形で返す（ニギニギ隊全員の分＋本部の分の合計）。
function getTodayFillingTotals(plan){
  const totals = {};
  const toItems = qtyMap => Object.entries(qtyMap || {}).map(([filling, qty]) => ({ filling, qty }));
  (plan.memberNames || []).forEach(name => {
    toItems(plan.memberFillingQty[name]).forEach(it => {
      if(it.qty > 0) totals[it.filling] = (totals[it.filling] || 0) + it.qty;
    });
  });
  toItems(plan.hqBreakdown).forEach(it => {
    if(it.qty > 0) totals[it.filling] = (totals[it.filling] || 0) + it.qty;
  });
  return totals;
}

// 確定プランに具材別の内訳（zuidBreakdown/uvaBreakdown）がある場合は最優先でそれを使う。
// 無い場合（確定プランがその日無い、または内訳列が無い古い確定行）は
// ドラフトの zuidFillingQty / uvaFillingQty を使い（draftForecastを渡さない呼び出し元
// ＝uva.html/rozen.htmlでは常にスキップされる）、それも無い場合は全具材合計を
// zuid:uva の比率で按分して返す。FILLINGS（具材名の配列）は呼び出しページ側で定義する。
function getStoreTotals(plan, draftForecast){
  if(plan && plan.hasDetailBreakdown){
    const z = {}, u = {}, ro = {};
    FILLINGS.forEach(f => {
      z[f] = Number(plan.zuidBreakdown[f] || 0);
      u[f] = Number(plan.uvaBreakdown[f] || 0);
      ro[f] = Number((plan.rozenBreakdown && plan.rozenBreakdown[f]) || 0);
    });
    return { zuidTotals: z, uvaTotals: u, rozenTotals: ro };
  }
  if(draftForecast && draftForecast.zuidFillingQty && draftForecast.uvaFillingQty){
    const z = {}, u = {}, ro = {};
    FILLINGS.forEach(f => {
      z[f] = Number(draftForecast.zuidFillingQty[f] || 0);
      u[f] = Number(draftForecast.uvaFillingQty[f] || 0);
      ro[f] = Number((draftForecast.rozenFillingQty && draftForecast.rozenFillingQty[f]) || 0);
    });
    return { zuidTotals: z, uvaTotals: u, rozenTotals: ro };
  }
  // フォールバック：全具材合計を店舗合計比率で按分（Rozengrachtは按分せず確定数のみ別枠で加える）
  const all = getTodayFillingTotals(plan);
  const grand = (plan.zuid || 0) + (plan.uva || 0);
  const ratio = grand > 0 ? (plan.zuid || 0) / grand : 0.5;
  const z = {}, u = {}, ro = {};
  FILLINGS.forEach(f => {
    const t = all[f] || 0;
    z[f] = Math.round(t * ratio);
    u[f] = t - z[f];
    ro[f] = 0;
  });
  return { zuidTotals: z, uvaTotals: u, rozenTotals: ro };
}

// 各時間帯残数と、その時間帯の「あげた数」「受け取った数」から、時間帯ごとの売れた数・
// 累計売上を算出する（Code.gsのcalcHourlySoldAndCumulativeと完全に同じ式。
// サーバー側で保存時に計算する値と、クライアント側で入力中にリアルタイム表示する値を
// 一致させるため、計算式を2か所に別々に書かず、必ずこの関数を経由する）。
// あげた数はその時間帯で実際に減った分から除外し、受け取った数（他店舗からの合流分）は
// 見かけ上残数が増える要因のため加算してから、「純粋な販売数」を算出する。
// 売れた数[i] = (i==0 ? 作った数 : 直前の残数) + 受け取った数[i] - 残数[i] - あげた数[i]
//              （残数の前後どちらかが未入力ならnull）
// 累計売上[i] = 作った数 + (0〜iの受け取った数の累計) - 残数[i] - (0〜iのあげた数の累計)（残数が未入力ならnull）
function calcHourlySoldAndCumulative(made, remains, givens, receiveds){
  const sold = [];
  const cumulative = [];
  let prev = made;
  let givenSum = 0;
  let receivedSum = 0;
  for(let i = 0; i < remains.length; i++){
    const curr = remains[i];
    const hasCurr = curr !== "" && curr !== null && curr !== undefined;
    const hasPrev = prev !== "" && prev !== null && prev !== undefined;
    const given = Number(givens[i] || 0);
    const received = Number((receiveds && receiveds[i]) || 0);
    sold.push(hasCurr && hasPrev ? (Number(prev) + received - Number(curr) - given) : null);
    givenSum += given;
    receivedSum += received;
    const hasMade = made !== "" && made !== null && made !== undefined;
    cumulative.push(hasCurr && hasMade ? (Number(made) + receivedSum - Number(curr) - givenSum) : null);
    prev = curr;
  }
  return { sold, cumulative };
}

// 1店舗分の「売れた数・累計・合計」表示をDOMに反映する（入力中のリアルタイム更新、
// および読み込み直後の初期表示の両方で使う）。slotsを省略した場合はHOURLY_SLOTSを使う。
function updateStoreSoldDisplay(storeKey, fillings, slots){
  const hourlySlots = slots || HOURLY_SLOTS;
  const nSlots = hourlySlots.length;
  const remainTotals = new Array(nSlots).fill(0);
  const soldTotals = new Array(nSlots).fill(0);
  const cumTotals = new Array(nSlots).fill(0);
  const remainCount = new Array(nSlots).fill(0);
  const soldCount = new Array(nSlots).fill(0);
  const cumCount = new Array(nSlots).fill(0);
  let madeTotal = 0;
  let movedTotal = 0;
  let movedUvaTotal = 0;
  let movedRozenTotal = 0;

  fillings.forEach((f, fi) => {
    const madeEl = document.querySelector(`.made-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const made = madeEl ? (parseInt(madeEl.value, 10) || 0) : 0;
    madeTotal += made;

    const movedEl = document.querySelector(`.moved-input[data-store="${storeKey}"][data-filling="${f}"]`);
    if(movedEl) movedTotal += (parseInt(movedEl.value, 10) || 0);

    const movedUvaEl = document.querySelector(`.moved-uva-input[data-store="${storeKey}"][data-filling="${f}"]`);
    if(movedUvaEl) movedUvaTotal += (parseInt(movedUvaEl.value, 10) || 0);

    const movedRozenEl = document.querySelector(`.moved-rozen-input[data-store="${storeKey}"][data-filling="${f}"]`);
    if(movedRozenEl) movedRozenTotal += (parseInt(movedRozenEl.value, 10) || 0);

    // 完売後の自動ゼロ入力：残数が0になったら以降の空欄に0を入力
    let hitZero = false;
    hourlySlots.forEach((h, si) => {
      const el = document.querySelector(`.hourly-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      if(!el) return;
      if(hitZero && el.value === "") el.value = "0";
      if(el.value !== "" && parseInt(el.value, 10) === 0) hitZero = true;
    });

    const vals = hourlySlots.map((h, si) => {
      const el = document.querySelector(`.hourly-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      return (el && el.value !== "") ? parseInt(el.value, 10) : null;
    });
    const givensArr = hourlySlots.map((h, si) => {
      const el = document.querySelector(`.given-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      return el ? (parseInt(el.value, 10) || 0) : 0;
    });
    const receivedsArr = hourlySlots.map((h, si) => {
      const el = document.querySelector(`.received-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      return el ? (parseInt(el.value, 10) || 0) : 0;
    });

    const { sold, cumulative } = calcHourlySoldAndCumulative(made, vals, givensArr, receivedsArr);

    let lastKnownCum = null;
    hourlySlots.forEach((h, si) => {
      const soldEl = document.getElementById(`sold-${storeKey}-${fi}-${si}`);
      const cumEl = document.getElementById(`cum-${storeKey}-${fi}-${si}`);
      const curr = vals[si];
      if(curr !== null){
        remainTotals[si] += curr;
        remainCount[si]++;
      }

      const cum = cumulative[si];
      if(cum !== null){
        if(cumEl) cumEl.textContent = `累計:${cum}`;
        cumTotals[si] += cum;
        cumCount[si]++;
        lastKnownCum = cum;
      } else {
        if(cumEl) cumEl.textContent = "";
        // 「全具材累計売上」は本来"その時点までの累計"を表す値のため、この具材だけ
        // その時間帯が未入力でも合計から丸ごと除外してしまうと、他の具材は入力済みなのに
        // 合計だけ不自然に小さくなってしまう。その具材の直近に判明している累計値を
        // そのまま繰り越して合計に含めることで、未入力の具材が1つでもあると合計が
        // 実態より小さく見える問題を防ぐ。
        if(lastKnownCum !== null){
          cumTotals[si] += lastKnownCum;
          cumCount[si]++;
        }
      }

      const s = sold[si];
      if(s === null){ if(soldEl) soldEl.textContent = ""; return; }
      if(soldEl){
        soldEl.textContent = `売:${s}`;
        soldEl.className = s < 0 ? "sold-display sold-neg" : "sold-display";
      }
      soldTotals[si] += s;
      soldCount[si]++;
    });
  });

  // 合計行を更新
  const mEl = document.getElementById(`total-made-${storeKey}`);
  if(mEl) mEl.textContent = String(madeTotal);
  const movedEl = document.getElementById(`total-moved-${storeKey}`);
  if(movedEl) movedEl.textContent = String(movedTotal);
  const movedUvaEl = document.getElementById(`total-movedUva-${storeKey}`);
  if(movedUvaEl) movedUvaEl.textContent = String(movedUvaTotal);
  const movedRozenEl = document.getElementById(`total-movedRozen-${storeKey}`);
  if(movedRozenEl) movedRozenEl.textContent = String(movedRozenTotal);
  let soldGrandTotal = 0;
  let soldGrandCount = 0;
  hourlySlots.forEach((h, si) => {
    const rEl = document.getElementById(`total-remain-${storeKey}-${si}`);
    const sEl = document.getElementById(`total-sold-${storeKey}-${si}`);
    const cEl = document.getElementById(`total-cum-${storeKey}-${si}`);
    if(rEl) rEl.textContent = remainCount[si] > 0 ? String(remainTotals[si]) : "";
    if(sEl) sEl.textContent = soldCount[si] > 0 ? String(soldTotals[si]) : "";
    if(cEl) cEl.textContent = cumCount[si] > 0 ? String(cumTotals[si]) : "";
    if(soldCount[si] > 0){ soldGrandTotal += soldTotals[si]; soldGrandCount++; }
  });
  // 「作った数」列の位置に、全時間帯・全具材を通した売った合計数を表示する
  const sgEl = document.getElementById(`total-sold-grand-${storeKey}`);
  if(sgEl) sgEl.textContent = soldGrandCount > 0 ? String(soldGrandTotal) : "";
}

// dateIso（yyyy-MM-dd）を指定すると、Apps Script側でその日付の行だけに絞って
// 返すため、実績シートの行数が増えてもレスポンスが肥大化しない
async function fetchHourlyData(scriptUrl, dateIso){
  try{
    const url = `${scriptUrl}?type=hourly${dateIso ? `&date=${encodeURIComponent(dateIso)}` : ""}`;
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json();
    return json.rows || [];
  }catch(e){
    console.warn("時間帯別実績の取得失敗:", e);
    return [];
  }
}

// rows（fetchHourlyDataの結果）の中から、指定した店舗の行の中で最も新しい更新日時
// （epochミリ秒）を返す。該当行が無い、またはどの行も更新日時を持たない場合はnull。
// 保存前の楽観的ロックのチェックに使う。
function maxUpdatedAtForStore(rows, storeKey){
  let max = null;
  (rows || []).forEach(row => {
    if(row.store !== storeKey) return;
    const v = row.updatedAt;
    if(v === "" || v === null || v === undefined) return;
    const n = Number(v);
    if(!isNaN(n) && (max === null || n > max)) max = n;
  });
  return max;
}

function restoreHourlyInputs(rows, todayIso, slots){
  const hourlySlots = slots || HOURLY_SLOTS;
  const slotKeys = hourlySlots.map(h => `r${h}`);
  const givenKeys = hourlySlots.map(h => `given${h}`);
  const receivedKeys = hourlySlots.map(h => `received${h}`);
  const lunchKeys = hourlySlots.map(h => `lunch${h}`);
  const stampKeys = hourlySlots.map(h => `stamp${h}`);
  const noteRestored = {};
  const soldOutRestored = {};
  rows.filter(r => r.date === todayIso).forEach(row => {
    const sk = row.store;
    const f  = row.filling;
    // 作った数を復元
    const madeEl = document.querySelector(`.made-input[data-store="${sk}"][data-filling="${f}"]`);
    if(madeEl && row.total !== "" && row.total !== null && row.total !== undefined)
      madeEl.value = row.total;
    // Zuidへ移動した数を復元（UvA・Rozengracht）
    if(row.movedToZuid !== "" && row.movedToZuid !== null && row.movedToZuid !== undefined){
      const movedEl = document.querySelector(`.moved-input[data-store="${sk}"][data-filling="${f}"]`);
      if(movedEl) movedEl.value = String(row.movedToZuid);
    }
    // UvAへ移動した数を復元（Rozengrachtのみ）
    if(row.movedToUva !== "" && row.movedToUva !== null && row.movedToUva !== undefined){
      const movedUvaEl = document.querySelector(`.moved-uva-input[data-store="${sk}"][data-filling="${f}"]`);
      if(movedUvaEl) movedUvaEl.value = String(row.movedToUva);
    }
    // Rozengrachtへ移動した数を復元（Zuid・UvAのみ）
    if(row.movedToRozengracht !== "" && row.movedToRozengracht !== null && row.movedToRozengracht !== undefined){
      const movedRozenEl = document.querySelector(`.moved-rozen-input[data-store="${sk}"][data-filling="${f}"]`);
      if(movedRozenEl) movedRozenEl.value = String(row.movedToRozengracht);
    }
    // 時間帯残数・あげた数・受け取った数を復元
    slotKeys.forEach((key, si) => {
      const v = row[key];
      if(v !== "" && v !== null && v !== undefined){
        const el = document.querySelector(`.hourly-input[data-store="${sk}"][data-filling="${f}"][data-slot="${si}"]`);
        if(el) el.value = String(v);
      }
      // 新形式「あげた数」があればそれを使い、なければ旧形式（ランチ＋スタンプ）にフォールバックする
      let givenV = row[givenKeys[si]];
      if(givenV === "" || givenV === null || givenV === undefined){
        const lunchV = Number(row[lunchKeys[si]] || 0);
        const stampV = Number(row[stampKeys[si]] || 0);
        givenV = (lunchV || stampV) ? (lunchV + stampV) : "";
      }
      if(givenV !== "" && givenV !== null && givenV !== undefined){
        const givenEl = document.querySelector(`.given-input[data-store="${sk}"][data-filling="${f}"][data-slot="${si}"]`);
        if(givenEl) givenEl.value = String(givenV);
      }
      const receivedV = row[receivedKeys[si]];
      if(receivedV !== "" && receivedV !== null && receivedV !== undefined){
        const receivedEl = document.querySelector(`.received-input[data-store="${sk}"][data-filling="${f}"][data-slot="${si}"]`);
        if(receivedEl) receivedEl.value = String(receivedV);
      }
    });
    // 備考を復元（店舗ごとに1回）
    if(!noteRestored[sk] && row.note){
      const noteEl = document.getElementById(`notes-${sk}`);
      if(noteEl) noteEl.value = row.note;
      noteRestored[sk] = true;
    }
    // UvA 販売場所名を復元
    if(sk === "UvA" && row.location && row.location !== "UvA"){
      const locEl = document.getElementById("uvaLocationInput");
      if(locEl) locEl.value = row.location;
    }
    // 販売終了時間を復元（店舗ごとに1回）
    if(!soldOutRestored[sk] && row.soldOutTime){
      const soldOutEl = document.getElementById(`soldoutTime-${sk}`);
      if(soldOutEl) soldOutEl.value = row.soldOutTime;
      soldOutRestored[sk] = true;
    }
  });
}

// 1店舗分の実績をCode.gs（type=saveHourly）に保存する。保存直前にfetchHourlyDataで
// 最新データを取り直し、ctx.expectedUpdatedAtと比較することで楽観的ロックを行う
// （index.html・uva.html・rozen.htmlで同じ店舗・同じ日を同時に編集した場合、
// 後から保存しようとした側をここで止める）。
//
// ctx: {
//   scriptUrl, storeKey, dateIso, fillings, hourlySlots（省略可。既定はHOURLY_SLOTS）,
//   weekday（省略可。無ければdateIsoから算出）, weather（省略可）, temp（省略可）,
//   location（省略可。既定はstoreKey）, note（省略可）, soldOutTime（省略可）,
//   expectedUpdatedAt（省略可。無ければロックチェックをスキップする）,
// }
// 戻り値: { ok:true, savedAt:Date, expectedUpdatedAt } | { ok:false, reason:"conflict"|"network", error? }
const HOURLY_DAY_NAMES_JA = ["日","月","火","水","木","金","土"];

async function saveStoreActual(ctx){
  const { scriptUrl, storeKey, dateIso, fillings } = ctx;
  const hourlySlots = ctx.hourlySlots || HOURLY_SLOTS;

  // 保存前の楽観的ロックチェック：最新データを取り直し、読み込み時点の更新日時と比較する。
  // 異なっていれば、他の端末が先に保存したとみなし、ここで中断する（POSTは送らない）。
  if(ctx.expectedUpdatedAt !== undefined && ctx.expectedUpdatedAt !== null){
    const freshRows = await fetchHourlyData(scriptUrl, dateIso);
    const freshMax = maxUpdatedAtForStore(freshRows, storeKey);
    if(freshMax !== null && String(freshMax) !== String(ctx.expectedUpdatedAt)){
      return { ok: false, reason: "conflict" };
    }
  }

  const weekday = ctx.weekday || (HOURLY_DAY_NAMES_JA[new Date(`${dateIso}T00:00:00`).getDay()] + "曜");
  const location = ctx.location || storeKey;

  const items = fillings.map(f => {
    const madeEl = document.querySelector(`.made-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const made = madeEl ? (parseInt(madeEl.value, 10) || 0) : 0;
    const movedEl = document.querySelector(`.moved-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const moved = movedEl ? (parseInt(movedEl.value, 10) || 0) : 0;
    const movedUvaEl = document.querySelector(`.moved-uva-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const movedUva = movedUvaEl ? (parseInt(movedUvaEl.value, 10) || 0) : 0;
    const movedRozenEl = document.querySelector(`.moved-rozen-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const movedRozen = movedRozenEl ? (parseInt(movedRozenEl.value, 10) || 0) : 0;
    const sv = hourlySlots.map((h, si) => {
      const el = document.querySelector(`.hourly-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      return (el && el.value !== "") ? parseInt(el.value, 10) : "";
    });
    const gv = hourlySlots.map((h, si) => {
      const el = document.querySelector(`.given-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      return el ? (parseInt(el.value, 10) || 0) : 0;
    });
    const rv = hourlySlots.map((h, si) => {
      const el = document.querySelector(`.received-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      return el ? (parseInt(el.value, 10) || 0) : 0;
    });
    const item = { filling: f, total: made, movedToZuid: moved, movedToUva: movedUva, movedToRozengracht: movedRozen };
    hourlySlots.forEach((h, si) => {
      item[`r${h}`] = sv[si];
      item[`given${h}`] = gv[si];
      item[`received${h}`] = rv[si];
    });
    return item;
  });

  const payload = {
    type: "saveHourly",
    date: dateIso,
    weekday,
    weather: ctx.weather || "",
    temp: (ctx.temp !== undefined && ctx.temp !== null) ? ctx.temp : "",
    stores: [{
      store: storeKey, location, items,
      // note/soldOutTimeは、呼び出し元が指定しなかった場合はundefinedのままにする
      // （JSON.stringifyでキーごと省略される）。uva.html/rozen.htmlはこの欄のUIを
      // 持たないため指定しない＝Code.gs側で既存の値がそのまま保たれる
      // （空文字を明示的に送ると「意図的に空にした」とみなされ上書きされてしまうため）。
      note: ctx.note, soldOutTime: ctx.soldOutTime,
      expectedUpdatedAt: ctx.expectedUpdatedAt || undefined,
    }],
  };

  try{
    await fetch(scriptUrl, { method: "POST", mode: "no-cors", body: JSON.stringify(payload) });
    // no-corsのレスポンスは中身を読めないため、保存できたかどうかは分からない。
    // 保存直後にもう一度読み直し、次回保存時の楽観的ロック基準（expectedUpdatedAt）を
    // 最新化しておく（呼び出し元の画面更新にも使ってよい）。
    const freshRows = await fetchHourlyData(scriptUrl, dateIso);
    const newExpected = maxUpdatedAtForStore(freshRows, storeKey);
    return { ok: true, savedAt: new Date(), expectedUpdatedAt: newExpected, rows: freshRows };
  }catch(e){
    return { ok: false, reason: "network", error: e };
  }
}

// ========== 時間帯別実績：入力モード（共通部品） ==========
// 1マスに「残り／あげた数／受け取った数」が密集した表（buildStoreTable）は、どこに
// 入力しているか分かりにくく誤タップしやすいため、1時間帯ずつ・具材を縦に並べて
// 大きな入力欄で入力する「入力モード」を既定の入力画面にする。元の表は「一覧」
// （確認用・読み取り専用）として残す。index.html（複数店舗）・uva.html/rozen.html
// （単一店舗）のいずれからも同じ部品で呼び出せるようにする。
// 入力欄のclass名・data属性（.hourly-input/.given-input/.received-input/.made-input/
// .moved-input等、data-store/data-filling/data-slot）は元の表と完全に同じものを使う。
// そのため、売れた数・累計の計算（calcHourlySoldAndCumulative）・保存（saveStoreActual）・
// 復元（restoreHourlyInputs）は一切変更せずそのまま動く。

// 今の時刻に一番近い時間帯のインデックスを返す（差が同じ場合は早い方を優先）
function nearestHourlySlotIndex(hourlySlots, now){
  const n = now || new Date();
  const nowHour = n.getHours() + n.getMinutes() / 60;
  let bestIdx = 0, bestDiff = Infinity;
  hourlySlots.forEach((h, i) => {
    const diff = Math.abs(h - nowHour);
    if(diff < bestDiff){ bestDiff = diff; bestIdx = i; }
  });
  return bestIdx;
}

// 「前の時間帯の残り」の参考表示を更新する（入力モード専用の表示。売れた数・累計は
// updateStoreSoldDisplay（元のまま）が書き込むsold-*/cum-*をそのまま使う）
function updateHourlyPrevRefDisplays(storeKey, fillings, hourlySlots){
  fillings.forEach((f, fi) => {
    const madeEl = document.querySelector(`.made-input[data-store="${storeKey}"][data-filling="${f}"]`);
    let prev = madeEl ? madeEl.value : "";
    hourlySlots.forEach((h, si) => {
      const refEl = document.getElementById(`ref-prev-${storeKey}-${fi}-${si}`);
      if(refEl) refEl.textContent = (prev !== "" && prev !== null && prev !== undefined) ? `前の残り:${prev}` : "";
      const el = document.querySelector(`.hourly-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      prev = el ? el.value : "";
    });
  });
}

// 1店舗・全時間帯分の、具材ごとの入力行HTML（入力モード本体。時間帯ごとにグループ化し、
// JS側でdisplayを切り替えて1時間帯だけ見せる）を組み立てる
function buildHourlyInputRowsHtml(storeDef, fillings, hourlySlots, activeSlotIndex){
  const { key: storeKey, totals, madeReadonly, showReceived, showMovedToZuid, showMovedToUva, showMovedToRozengracht } = storeDef;
  const lastSlotIndex = hourlySlots.length - 1;
  const groups = hourlySlots.map((h, si) => {
    const rows = fillings.map((f, fi) => {
      const isLastSlot = si === lastSlotIndex;
      const movedRowHtml = isLastSlot ? `
        <div class="hourly-moved-row">
          ${showMovedToZuid ? `<label class="hourly-moved-field"><span>Zuidへ移動</span><input type="number" inputmode="numeric" class="moved-input" data-store="${storeKey}" data-filling="${f}" min="0" placeholder="0" value="0"></label>` : ""}
          ${showMovedToUva ? `<label class="hourly-moved-field"><span>UvAへ移動</span><input type="number" inputmode="numeric" class="moved-uva-input" data-store="${storeKey}" data-filling="${f}" min="0" placeholder="0" value="0"></label>` : ""}
          ${showMovedToRozengracht ? `<label class="hourly-moved-field"><span>Rozengrachtへ移動</span><input type="number" inputmode="numeric" class="moved-rozen-input" data-store="${storeKey}" data-filling="${f}" min="0" placeholder="0" value="0"></label>` : ""}
        </div>` : "";
      return `
        <div class="hourly-input-row" data-store="${storeKey}" data-filling="${f}" data-slot="${si}" style="${si === activeSlotIndex ? "" : "display:none;"}">
          <div class="hourly-row-head">
            <span class="hourly-row-filling-name">${f}</span>
            <label class="hourly-made-field" title="作った数">
              作<input type="number" inputmode="numeric" class="made-input" data-store="${storeKey}" data-filling="${f}" value="${totals[f]}" min="0"${madeReadonly ? " readonly" : ""}>
            </label>
          </div>
          <div class="hourly-row-fields">
            <label class="hourly-field hourly-field-remain">
              <span class="hourly-field-label">残り</span>
              <input type="number" inputmode="numeric" enterkeyhint="next" class="hourly-input" data-store="${storeKey}" data-filling="${f}" data-slot="${si}" min="0" placeholder="—">
            </label>
            <label class="hourly-field hourly-field-given">
              <span class="hourly-field-label">あげた数</span>
              <input type="number" inputmode="numeric" class="given-input" data-store="${storeKey}" data-filling="${f}" data-slot="${si}" min="0" placeholder="0" value="0">
            </label>
            ${showReceived ? `
            <label class="hourly-field hourly-field-received">
              <span class="hourly-field-label">受け取った数</span>
              <input type="number" inputmode="numeric" class="received-input" data-store="${storeKey}" data-filling="${f}" data-slot="${si}" min="0" placeholder="0" value="0">
            </label>` : ""}
          </div>
          <div class="hourly-row-ref">
            <span class="hourly-ref-prev" id="ref-prev-${storeKey}-${fi}-${si}"></span>
            <span class="sold-display" id="sold-${storeKey}-${fi}-${si}"></span>
            <span class="cum-display" id="cum-${storeKey}-${fi}-${si}" style="display:none;"></span>
          </div>
          ${movedRowHtml}
        </div>`;
    }).join("");
    return rows;
  }).join("");
  // footerHtml（任意）：販売終了時間・販売場所・メモなど、時間帯に関係なく店舗ごとに1つだけ
  // 持つ欄を呼び出し元から渡せる。店舗タブの表示/非表示と同じdisplay切り替えに相乗りする
  return `<div class="hourly-store-rows" data-store="${storeKey}" style="${storeDef.active ? "" : "display:none;"}">${groups}${storeDef.footerHtml || ""}</div>`;
}

// 入力モードの土台（上部固定バー・店舗タブ・時間帯タブ・入力行コンテナ・一覧表示用コンテナ）
// のHTML。storeDefsは [{key,label,totals,madeReadonly,showReceived,showMovedToZuid,
// showMovedToUva,showMovedToRozengracht}]。showStoreTabsはindex.htmlのみtrue。
function buildHourlyInputModeHtml(storeDefs, fillings, hourlySlots, activeStoreKey, activeSlotIndex, showStoreTabs){
  const defsWithActive = storeDefs.map(s => ({ ...s, active: s.key === activeStoreKey }));
  const storeTabsHtml = (showStoreTabs && storeDefs.length > 1) ? `
    <div class="hourly-store-tabs" id="hourlyStoreTabs">
      ${storeDefs.map(s => `<button type="button" class="hourly-store-tab${s.key === activeStoreKey ? " active" : ""}" data-store="${s.key}">${s.label}</button>`).join("")}
    </div>` : "";
  const slotTabsHtml = `
    <div class="hourly-slot-tabs" id="hourlySlotTabs">
      ${hourlySlots.map((h, si) => `<button type="button" class="hourly-slot-tab${si === activeSlotIndex ? " active" : ""}" data-slot="${si}">${h}時</button>`).join("")}
    </div>`;
  const rowsHtml = defsWithActive.map(s => buildHourlyInputRowsHtml(s, fillings, hourlySlots, activeSlotIndex)).join("");
  const activeLabel = (storeDefs.find(s => s.key === activeStoreKey) || {}).label || activeStoreKey;
  return `
    <div class="hourly-mode-bar" id="hourlyModeBar">
      <div class="hourly-mode-bar-row">
        <span class="hourly-mode-bar-store" id="hourlyBarStore">${activeLabel}</span>
        <span class="hourly-mode-bar-slot" id="hourlyBarSlot">${hourlySlots[activeSlotIndex]}時</span>
        <span class="hourly-mode-bar-status" id="hourlyBarStatus"></span>
        <button type="button" class="hourly-view-toggle-btn" id="hourlySaveNowBtn">💾 保存</button>
        <button type="button" class="hourly-view-toggle-btn" id="hourlyViewToggleBtn">📋 一覧</button>
      </div>
      <div class="hourly-mode-bar-filling" id="hourlyBarFilling"></div>
    </div>
    ${storeTabsHtml}
    ${slotTabsHtml}
    <div id="hourlyInputRows">${rowsHtml}</div>
    <div id="hourlyListViewArea" class="hourly-list-view-area" style="display:none;"></div>
  `;
}

// 一覧（確認用・読み取り専用）の表HTML。buildStoreTable（従来の密な表）と同じクラス名・
// 列構成にすることで、hourly-table.cssの固定列・サイズ指定（index.htmlの上書き含む）を
// そのまま流用する。入力欄は持たず、タップするとその時間帯・具材の入力モードに移る。
function buildHourlyListTableHtml(storeKey, fillings, hourlySlots, showReceived, showMovedToZuid, showMovedToUva, showMovedToRozengracht){
  const slotSubhead = showReceived ? "残り／あげ／受取" : "残り／あげ";
  const slotHeaders = hourlySlots.map(h => `<th>${h}時<br><span class="slot-subhead">${slotSubhead}</span></th>`).join("");
  const rows = fillings.map((f, fi) => {
    const slotCells = hourlySlots.map((h, si) => `
      <td class="hourly-list-cell" data-store="${storeKey}" data-filling="${f}" data-slot="${si}">
        <div class="hourly-list-remain" id="list-remain-${storeKey}-${fi}-${si}">—</div>
        <div class="hourly-list-sub" id="list-extra-${storeKey}-${fi}-${si}"></div>
        <div class="sold-display" id="list-sold-${storeKey}-${fi}-${si}"></div>
      </td>`).join("");
    const movedZuidCell = showMovedToZuid ? `<td><span id="list-moved-${storeKey}-${fi}"></span></td>` : "";
    const movedUvaCell = showMovedToUva ? `<td><span id="list-movedUva-${storeKey}-${fi}"></span></td>` : "";
    const movedRozenCell = showMovedToRozengracht ? `<td><span id="list-movedRozen-${storeKey}-${fi}"></span></td>` : "";
    return `<tr>
      <td class="col-name hourly-list-cell" data-store="${storeKey}" data-filling="${f}" data-slot="0">${f}</td>
      <td><span id="list-made-${storeKey}-${fi}"></span></td>
      ${movedZuidCell}
      ${movedUvaCell}
      ${movedRozenCell}
      ${slotCells}
    </tr>`;
  }).join("");
  const movedZuidHeader = showMovedToZuid ? `<th>Zuidへ<br>移動</th>` : "";
  const movedUvaHeader = showMovedToUva ? `<th>UvAへ<br>移動</th>` : "";
  const movedRozenHeader = showMovedToRozengracht ? `<th>Rozengrachtへ<br>移動</th>` : "";
  // 合計行：updateStoreSoldDisplay（元のまま変更していない）が書き込むtotal-*のidを
  // そのまま使うことで、全具材合計の表示を一覧（確認用）側で引き継ぐ
  const remainCells = hourlySlots.map((h, si) => `<td class="total-cell"><span id="total-remain-${storeKey}-${si}"></span></td>`).join("");
  const soldCells = hourlySlots.map((h, si) => `<td class="total-cell"><span id="total-sold-${storeKey}-${si}"></span></td>`).join("");
  const cumCells = hourlySlots.map((h, si) => `<td class="total-cell"><span id="total-cum-${storeKey}-${si}"></span></td>`).join("");
  const movedZuidTotalCell = showMovedToZuid ? `<td class="total-cell"><span id="total-moved-${storeKey}"></span></td>` : "";
  const movedUvaTotalCell = showMovedToUva ? `<td class="total-cell"><span id="total-movedUva-${storeKey}"></span></td>` : "";
  const movedRozenTotalCell = showMovedToRozengracht ? `<td class="total-cell"><span id="total-movedRozen-${storeKey}"></span></td>` : "";
  const movedPlaceholderCells = `${showMovedToZuid ? "<td>—</td>" : ""}${showMovedToUva ? "<td>—</td>" : ""}${showMovedToRozengracht ? "<td>—</td>" : ""}`;
  return `<div class="table-scroll table-scroll--bounded"><table class="hourly-table">
    <thead><tr><th class="col-name">具材</th><th>作った数</th>${movedZuidHeader}${movedUvaHeader}${movedRozenHeader}${slotHeaders}</tr></thead>
    <tbody>
      ${rows}
      <tr class="total-row"><td class="col-name">残り合計</td><td class="total-cell"><span id="total-made-${storeKey}"></span></td>${movedZuidTotalCell}${movedUvaTotalCell}${movedRozenTotalCell}${remainCells}</tr>
      <tr class="total-row"><td class="col-name">売った合計</td><td class="total-cell"><span id="total-sold-grand-${storeKey}"></span></td>${movedPlaceholderCells}${soldCells}</tr>
      <tr class="total-row"><td class="col-name">全具材累計売上</td><td>—</td>${movedPlaceholderCells}${cumCells}</tr>
    </tbody>
  </table></div>`;
}

// 一覧の表示内容を、入力モード側の実際の入力値から読み取って更新する（読み取り専用の
// 値表示のみ。計算はcalcHourlySoldAndCumulative（元のまま）をそのまま使う）
function refreshHourlyListView(storeKey, fillings, hourlySlots){
  fillings.forEach((f, fi) => {
    const madeEl = document.querySelector(`.made-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const madeOut = document.getElementById(`list-made-${storeKey}-${fi}`);
    if(madeOut) madeOut.textContent = madeEl ? (madeEl.value || "0") : "0";

    const movedEl = document.querySelector(`.moved-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const movedOut = document.getElementById(`list-moved-${storeKey}-${fi}`);
    if(movedOut) movedOut.textContent = movedEl ? (movedEl.value || "0") : "0";
    const movedUvaEl = document.querySelector(`.moved-uva-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const movedUvaOut = document.getElementById(`list-movedUva-${storeKey}-${fi}`);
    if(movedUvaOut) movedUvaOut.textContent = movedUvaEl ? (movedUvaEl.value || "0") : "0";
    const movedRozenEl = document.querySelector(`.moved-rozen-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const movedRozenOut = document.getElementById(`list-movedRozen-${storeKey}-${fi}`);
    if(movedRozenOut) movedRozenOut.textContent = movedRozenEl ? (movedRozenEl.value || "0") : "0";

    hourlySlots.forEach((h, si) => {
      const remainEl = document.querySelector(`.hourly-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      const givenEl = document.querySelector(`.given-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      const receivedEl = document.querySelector(`.received-input[data-store="${storeKey}"][data-filling="${f}"][data-slot="${si}"]`);
      const remainOut = document.getElementById(`list-remain-${storeKey}-${fi}-${si}`);
      const extraOut = document.getElementById(`list-extra-${storeKey}-${fi}-${si}`);
      const soldOut = document.getElementById(`list-sold-${storeKey}-${fi}-${si}`);
      const soldSrc = document.getElementById(`sold-${storeKey}-${fi}-${si}`);
      if(remainOut) remainOut.textContent = (remainEl && remainEl.value !== "") ? remainEl.value : "—";
      if(extraOut){
        const given = givenEl ? (parseInt(givenEl.value, 10) || 0) : 0;
        const received = receivedEl ? (parseInt(receivedEl.value, 10) || 0) : 0;
        const parts = [];
        if(given > 0) parts.push(`あげ${given}`);
        if(received > 0) parts.push(`受取${received}`);
        extraOut.textContent = parts.join("/");
      }
      if(soldOut) soldOut.textContent = soldSrc ? soldSrc.textContent : "";
      if(soldOut) soldOut.className = soldSrc ? soldSrc.className : "sold-display";
    });
  });
}

// 店舗・時間帯切り替え時に、保留中（デバウンス待ち）の保存があれば即座に行う。
// 何も変更されていなければ何もしない（無駄な保存リクエストを送らない）。
const hourlySaveTimers = {};
function scheduleHourlySave(storeKey, saveFn, delayMs){
  if(hourlySaveTimers[storeKey]) clearTimeout(hourlySaveTimers[storeKey].timer);
  const timer = setTimeout(() => {
    delete hourlySaveTimers[storeKey];
    saveFn();
  }, delayMs !== undefined ? delayMs : 800);
  hourlySaveTimers[storeKey] = { timer, saveFn };
}
function flushHourlySave(storeKey){
  const pending = hourlySaveTimers[storeKey];
  if(!pending) return false;
  clearTimeout(pending.timer);
  delete hourlySaveTimers[storeKey];
  pending.saveFn();
  return true;
}

// 入力モードのイベント結線一式。opts: {
//   storeDefs, fillings, hourlySlots, showStoreTabs,
//   getActiveStoreKey()/setActiveStoreKey(key)（呼び出し元のstateと同期するため）,
//   getActiveSlotIndex()/setActiveSlotIndex(i),
//   save(storeKey)（呼び出し元が持つ実際の保存処理。saveStoreActual呼び出しを含む）,
// }
function bindHourlyInputMode(opts){
  const { storeDefs, fillings, hourlySlots, save } = opts;
  let activeStoreKey = opts.getActiveStoreKey();
  let activeSlotIndex = opts.getActiveSlotIndex();
  let listViewOpen = false;

  function storeDef(key){ return storeDefs.find(s => s.key === key); }

  function refreshActiveDisplays(){
    updateStoreSoldDisplay(activeStoreKey, fillings, hourlySlots);
    updateHourlyPrevRefDisplays(activeStoreKey, fillings, hourlySlots);
  }

  function updateBar(){
    const d = storeDef(activeStoreKey);
    const barStore = document.getElementById("hourlyBarStore");
    const barSlot = document.getElementById("hourlyBarSlot");
    if(barStore) barStore.textContent = d ? d.label : activeStoreKey;
    if(barSlot) barSlot.textContent = `${hourlySlots[activeSlotIndex]}時`;
  }

  function setBarFilling(name){
    const el = document.getElementById("hourlyBarFilling");
    if(el) el.textContent = name ? `入力中：${name}` : "";
  }

  function setStatus(text){
    const el = document.getElementById("hourlyBarStatus");
    if(el) el.textContent = text || "";
  }

  function showStoreRows(key){
    document.querySelectorAll("#hourlyInputRows .hourly-store-rows").forEach(el => {
      el.style.display = el.dataset.store === key ? "" : "none";
    });
  }

  function showSlotRows(key, slotIndex){
    const container = document.querySelector(`#hourlyInputRows .hourly-store-rows[data-store="${key}"]`);
    if(!container) return;
    container.querySelectorAll(".hourly-input-row").forEach(row => {
      row.style.display = Number(row.dataset.slot) === slotIndex ? "" : "none";
    });
  }

  function markTabsActive(){
    document.querySelectorAll("#hourlyStoreTabs .hourly-store-tab").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.store === activeStoreKey);
    });
    document.querySelectorAll("#hourlySlotTabs .hourly-slot-tab").forEach(btn => {
      btn.classList.toggle("active", Number(btn.dataset.slot) === activeSlotIndex);
    });
  }

  function applyActiveView(){
    showStoreRows(activeStoreKey);
    showSlotRows(activeStoreKey, activeSlotIndex);
    markTabsActive();
    updateBar();
    refreshActiveDisplays();
    opts.setActiveStoreKey(activeStoreKey);
    opts.setActiveSlotIndex(activeSlotIndex);
  }

  function switchStore(key){
    if(key === activeStoreKey) return;
    flushHourlySave(activeStoreKey);
    activeStoreKey = key;
    applyActiveView();
  }

  function switchSlot(index){
    if(index === activeSlotIndex) return;
    flushHourlySave(activeStoreKey);
    activeSlotIndex = index;
    applyActiveView();
  }

  function focusFillingInStore(key, slotIndex, filling){
    switchStore(key);
    switchSlot(slotIndex);
    const input = document.querySelector(`#hourlyInputRows .hourly-input-row[data-store="${key}"][data-filling="${filling}"][data-slot="${slotIndex}"] .hourly-input`);
    if(input) input.focus();
  }

  const rowsContainer = document.getElementById("hourlyInputRows");

  // 入力欄の変更：表示更新＋デバウンス保存の予約（店舗・時間帯切替時にflushHourlySaveで
  // 即座に保存される。保存の0.8秒遅延の仕組みはこの関数が担う）
  rowsContainer.addEventListener("input", e => {
    const el = e.target;
    const store = el.dataset.store;
    if(!store || !(el.classList.contains("hourly-input") || el.classList.contains("given-input") ||
       el.classList.contains("received-input") || el.classList.contains("made-input") ||
       el.classList.contains("moved-input") || el.classList.contains("moved-uva-input") || el.classList.contains("moved-rozen-input"))) return;
    updateStoreSoldDisplay(store, fillings, hourlySlots);
    updateHourlyPrevRefDisplays(store, fillings, hourlySlots);
    setStatus("未保存の変更があります");
    scheduleHourlySave(store, () => {
      setStatus("保存中...");
      Promise.resolve(save(store)).then(ok => {
        setStatus(ok === false ? "⚠️ 保存に失敗しました" : "✓ 保存しました");
      });
    });
  });

  // キーボードの「次へ」：残りの欄でEnter（iPhoneの数字キーパッドの「次へ」）を押すと、
  // 同じ時間帯の次の具材の「残り」欄に移動する
  rowsContainer.addEventListener("keydown", e => {
    if(e.key !== "Enter") return;
    const el = e.target;
    if(!el.classList || !el.classList.contains("hourly-input")) return;
    e.preventDefault();
    const activeGroup = document.querySelector(`#hourlyInputRows .hourly-store-rows[data-store="${activeStoreKey}"]`);
    if(!activeGroup) return;
    const inputsInSlot = Array.from(activeGroup.querySelectorAll(`.hourly-input-row[data-slot="${activeSlotIndex}"] .hourly-input`));
    const idx = inputsInSlot.indexOf(el);
    if(idx !== -1 && idx < inputsInSlot.length - 1){
      inputsInSlot[idx + 1].focus();
    } else {
      el.blur();
    }
  });

  // 入力中の具材行をハイライト＋上部に具材名を固定表示する
  rowsContainer.addEventListener("focusin", e => {
    const row = e.target.closest(".hourly-input-row");
    rowsContainer.querySelectorAll(".hourly-input-row--active").forEach(r => r.classList.remove("hourly-input-row--active"));
    if(row){
      row.classList.add("hourly-input-row--active");
      setBarFilling(row.dataset.filling);
    }
  });
  rowsContainer.addEventListener("focusout", () => {
    // 少し遅らせて、同じ行の別の欄へのフォーカス移動では消えないようにする
    setTimeout(() => {
      if(!rowsContainer.contains(document.activeElement)) setBarFilling("");
    }, 0);
  });

  if(storeDefs.length > 1){
    document.querySelectorAll("#hourlyStoreTabs .hourly-store-tab").forEach(btn => {
      btn.addEventListener("click", () => switchStore(btn.dataset.store));
    });
  }
  document.querySelectorAll("#hourlySlotTabs .hourly-slot-tab").forEach(btn => {
    btn.addEventListener("click", () => switchSlot(Number(btn.dataset.slot)));
  });

  const saveNowBtn = document.getElementById("hourlySaveNowBtn");
  if(saveNowBtn){
    saveNowBtn.addEventListener("click", () => {
      clearTimeout((hourlySaveTimers[activeStoreKey] || {}).timer);
      delete hourlySaveTimers[activeStoreKey];
      setStatus("保存中...");
      Promise.resolve(save(activeStoreKey)).then(ok => {
        setStatus(ok === false ? "⚠️ 保存に失敗しました" : "✓ 保存しました");
      });
    });
  }

  const toggleBtn = document.getElementById("hourlyViewToggleBtn");
  const listArea = document.getElementById("hourlyListViewArea");
  const slotTabsEl = document.getElementById("hourlySlotTabs");
  function renderListView(){
    const d = storeDef(activeStoreKey);
    listArea.innerHTML = buildHourlyListTableHtml(activeStoreKey, fillings, hourlySlots,
      d.showReceived, d.showMovedToZuid, d.showMovedToUva, d.showMovedToRozengracht);
    // 一覧は毎回作り直すため、売れた数・累計（sold-*/cum-*）と合計行（total-*）の両方を
    // このタイミングで書き込み直す（先にupdateStoreSoldDisplayでsold-*/cum-*とtotal-*を
    // 最新化してから、refreshHourlyListViewでそれを読み取って一覧のセルに反映する）
    updateStoreSoldDisplay(activeStoreKey, fillings, hourlySlots);
    refreshHourlyListView(activeStoreKey, fillings, hourlySlots);
    listArea.querySelectorAll(".hourly-list-cell").forEach(cell => {
      cell.addEventListener("click", () => {
        const slotIndex = Number(cell.dataset.slot);
        listViewOpen = false;
        listArea.style.display = "none";
        rowsContainer.style.display = "";
        if(slotTabsEl) slotTabsEl.style.display = "";
        toggleBtn.textContent = "📋 一覧";
        focusFillingInStore(cell.dataset.store, slotIndex, cell.dataset.filling);
      });
    });
  }
  if(toggleBtn){
    toggleBtn.addEventListener("click", () => {
      listViewOpen = !listViewOpen;
      if(listViewOpen){
        flushHourlySave(activeStoreKey);
        renderListView();
        rowsContainer.style.display = "none";
        if(slotTabsEl) slotTabsEl.style.display = "none";
        listArea.style.display = "";
        toggleBtn.textContent = "✏️ 入力";
      } else {
        listArea.style.display = "none";
        rowsContainer.style.display = "";
        if(slotTabsEl) slotTabsEl.style.display = "";
        toggleBtn.textContent = "📋 一覧";
      }
    });
  }

  applyActiveView();

  return {
    refreshAll(){ storeDefs.forEach(s => { updateStoreSoldDisplay(s.key, fillings, hourlySlots); updateHourlyPrevRefDisplays(s.key, fillings, hourlySlots); }); if(listViewOpen) renderListView(); },
    getActiveStoreKey(){ return activeStoreKey; },
    getActiveSlotIndex(){ return activeSlotIndex; },
  };
}

// ---------- 今日の販売メモ（店舗×日付ごとに1つ。「時間帯別実績」シートの既存の
// 「備考」列にそのまま保存される。新しい列は追加しない）----------
// 500文字は目安（ハード制限ではない）。超えても保存できるが、入力欄の下に注意を表示する。
const NOTE_LENGTH_GUIDE = 500;

// index.html/uva.html/rozen.htmlで共通のメモ欄HTML。label省略時は「今日の販売メモ」
// （index.htmlの既存表記に合わせる）。
function buildNotesAreaHtml(storeKey, label){
  return `
    <div class="notes-area">
      <span class="notes-label">${label || "今日の販売メモ"}</span>
      <textarea id="notes-${storeKey}" rows="2" placeholder="天気の様子・特記事項など"></textarea>
      <div class="notes-warning" id="notesWarn-${storeKey}" style="display:none;">⚠️ ${NOTE_LENGTH_GUIDE}文字を超えています（保存はできますが、短くまとめることをおすすめします）</div>
    </div>`;
}

// buildNotesAreaHtml()で描画したメモ欄に、文字数の注意表示を紐付ける。
// renderActualSales等でテーブルを描画した直後に、店舗ごとに1回呼び出す。
function wireNoteLengthWarning(storeKey){
  const ta = document.getElementById(`notes-${storeKey}`);
  const warn = document.getElementById(`notesWarn-${storeKey}`);
  if(!ta || !warn) return;
  const check = () => { warn.style.display = ta.value.length > NOTE_LENGTH_GUIDE ? "" : "none"; };
  ta.addEventListener("input", check);
  check();
}
