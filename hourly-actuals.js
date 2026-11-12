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

// 1店舗分の実績入力テーブルのHTML（具材×時間帯の入力欄）を組み立てる。
// Zuid・Rozengrachtは、他店舗からの合流分「受け取った数」を時間帯ごとに入力できる
// （Zuidへの受け取りはUvAから、Rozengrachtへの受け取りはZuid・UvAから）。
// UvAのみ、営業終了時に残った分をZuidへ運ぶ「Zuidへ移動した数」を1日1回（具材ごと）入力できる。
// Zuid・UvAは、営業終了時に残った分をRozengrachtへ運ぶ「Rozengrachtへ移動した数」を
// 同じく1日1回（具材ごと）入力できる。
// slotsを省略した場合はHOURLY_SLOTS（既定の時間帯）を使う。
// madeReadonly=trueを指定すると「作った数」欄を読み取り専用にする（uva.html/rozen.html用。
// 確定プランの数を表示するだけで、スタッフが変更できないようにするため）。
// index.htmlは従来通りfalse（編集可能）のまま、動作を変えない。
function buildStoreTable(storeKey, fillings, totals, slots, madeReadonly){
  const hourlySlots = slots || HOURLY_SLOTS;
  const showReceived = storeKey === "Zuid" || storeKey === "Rozengracht";
  const showMovedToZuid = storeKey === "UvA";
  const showMovedToRozengracht = storeKey === "Zuid" || storeKey === "UvA";
  const receivedTitle = storeKey === "Zuid" ? "受け取った数（UvAから）" : "受け取った数（他店舗から）";
  const slotSubhead = showReceived ? "残り／あげ／受取" : "残り／あげ";
  const slotHeaders = hourlySlots.map(h => `<th>${h}時<br><span class="slot-subhead">${slotSubhead}</span></th>`).join("");
  const rows = fillings.map((f, fi) => {
    const slotCells = hourlySlots.map((h, si) => `
      <td>
        <input type="number" inputmode="numeric" class="hourly-input"
               data-store="${storeKey}" data-filling="${f}" data-slot="${si}"
               min="0" placeholder="—">
        <div class="slot-extra-row">
          <input type="number" inputmode="numeric" class="given-input" title="あげた数"
                 data-store="${storeKey}" data-filling="${f}" data-slot="${si}"
                 min="0" placeholder="あげ" value="0">
          ${showReceived ? `<input type="number" inputmode="numeric" class="received-input" title="${receivedTitle}"
                 data-store="${storeKey}" data-filling="${f}" data-slot="${si}"
                 min="0" placeholder="受取" value="0">` : ""}
        </div>
        <div class="sold-display" id="sold-${storeKey}-${fi}-${si}"></div>
        <div class="cum-display" id="cum-${storeKey}-${fi}-${si}"></div>
      </td>`).join("");
    const movedZuidCell = showMovedToZuid ? `<td><input type="number" inputmode="numeric" class="moved-input" title="Zuidへ移動した数"
                 data-store="${storeKey}" data-filling="${f}"
                 min="0" placeholder="0" value="0"></td>` : "";
    const movedRozenCell = showMovedToRozengracht ? `<td><input type="number" inputmode="numeric" class="moved-rozen-input" title="Rozengrachtへ移動した数"
                 data-store="${storeKey}" data-filling="${f}"
                 min="0" placeholder="0" value="0"></td>` : "";
    return `<tr>
      <td class="col-name">${f}</td>
      <td><input type="number" inputmode="numeric" class="made-input"
                 data-store="${storeKey}" data-filling="${f}"
                 value="${totals[f]}" min="0"${madeReadonly ? " readonly" : ""}></td>
      ${movedZuidCell}
      ${movedRozenCell}
      ${slotCells}
    </tr>`;
  }).join("");
  const remainCells = hourlySlots.map((h, si) =>
    `<td class="total-cell"><span id="total-remain-${storeKey}-${si}"></span></td>`).join("");
  const soldCells = hourlySlots.map((h, si) =>
    `<td class="total-cell"><span id="total-sold-${storeKey}-${si}"></span></td>`).join("");
  const cumCells = hourlySlots.map((h, si) =>
    `<td class="total-cell"><span id="total-cum-${storeKey}-${si}"></span></td>`).join("");
  const movedZuidHeader = showMovedToZuid ? `<th>Zuidへ<br>移動</th>` : "";
  const movedRozenHeader = showMovedToRozengracht ? `<th>Rozengrachtへ<br>移動</th>` : "";
  const movedZuidTotalCell = showMovedToZuid ? `<td class="total-cell"><span id="total-moved-${storeKey}"></span></td>` : "";
  const movedRozenTotalCell = showMovedToRozengracht ? `<td class="total-cell"><span id="total-movedRozen-${storeKey}"></span></td>` : "";
  const movedPlaceholderCells = `${showMovedToZuid ? "<td>—</td>" : ""}${showMovedToRozengracht ? "<td>—</td>" : ""}`;
  return `<table class="hourly-table">
    <thead><tr><th class="col-name">具材</th><th>作った数</th>${movedZuidHeader}${movedRozenHeader}${slotHeaders}</tr></thead>
    <tbody>
      ${rows}
      <tr class="total-row"><td class="col-name">残り合計</td><td class="total-cell"><span id="total-made-${storeKey}"></span></td>${movedZuidTotalCell}${movedRozenTotalCell}${remainCells}</tr>
      <tr class="total-row"><td class="col-name">売った合計</td><td class="total-cell"><span id="total-sold-grand-${storeKey}"></span></td>${movedPlaceholderCells}${soldCells}</tr>
      <tr class="total-row"><td class="col-name">全具材累計売上</td><td>—</td>${movedPlaceholderCells}${cumCells}</tr>
    </tbody>
  </table>`;
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
  let movedRozenTotal = 0;

  fillings.forEach((f, fi) => {
    const madeEl = document.querySelector(`.made-input[data-store="${storeKey}"][data-filling="${f}"]`);
    const made = madeEl ? (parseInt(madeEl.value, 10) || 0) : 0;
    madeTotal += made;

    const movedEl = document.querySelector(`.moved-input[data-store="${storeKey}"][data-filling="${f}"]`);
    if(movedEl) movedTotal += (parseInt(movedEl.value, 10) || 0);

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

// 複数店舗分まとめて更新したい呼び出し元（index.html）向けの薄いラッパー。
function updateSoldDisplay(storeKeys, fillings, slotsByStore){
  storeKeys.forEach(storeKey => updateStoreSoldDisplay(storeKey, fillings, slotsByStore && slotsByStore[storeKey]));
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
    // Zuidへ移動した数を復元（UvAのみ）
    if(row.movedToZuid !== "" && row.movedToZuid !== null && row.movedToZuid !== undefined){
      const movedEl = document.querySelector(`.moved-input[data-store="${sk}"][data-filling="${f}"]`);
      if(movedEl) movedEl.value = String(row.movedToZuid);
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
    const item = { filling: f, total: made, movedToZuid: moved, movedToRozengracht: movedRozen };
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
