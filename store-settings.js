// 「店舗設定」シート（営業期間・営業曜日・予測の方法・曜日ごとの基準値/固定数）の
// 共通読み込み・判定・予測計算処理。admin.html・index.html・uva.html・rozen.html・
// cooking.html・production.htmlのすべてで、この1つの実装を使う（ページごとに別々の実装を
// 持たない）。
//
// 各店舗は「予測の方法」として「天気で自動計算」（曜日ごとの基準値に気温・天気・保証の数の
// 調整をかける。Zuid・UvAのみ選択可）か「固定数」（曜日ごとの販売数をそのまま予測数にする）
// のどちらかを選べる。resolveStoreForecast()がこの呼び分けを一括して行う。
//
// 読み込みはgvizではなく、Code.gsのtype=storeSettingsエンドポイント（handleGetStoreSettings）
// 経由で行う。getDisplayValues()でシート上の表示文字列をそのまま取得するため、gvizの
// 「列ごとに値の型を多数決で決め、少数派の型の値をnullにする」仕様の影響を受けない
// （チセさん/今月のおにぎり担当シートと同じ対策）。
//
// 列の対応は固定位置（配列インデックス）ではなく、1行目のヘッダー文字列で探す。過去に
// 「月曜基準値」〜「日曜基準値」の列を既存の「更新日時」列の手前に追加したとき、位置決め打ちの
// 読み込みコードが列がずれたことに気づかず、保存済みの古い行（追加前の列数しか無い行）の
// 「更新日時」の値を「月曜基準値」として読んでしまいNaNになったり、他の曜日の基準値が
// すべて空欄として読まれて休業扱いになる不具合が起きた。ヘッダー名で探す方式なら、
// 今後また列が増えたり並び替わったりしても、ヘッダー名さえ変わらなければ正しく読める。

const STORE_SETTINGS_WEEKDAYS = [
  { key: "mon", label: "月", dow: 1, flagHeader: "月", baseHeader: "月曜基準値" },
  { key: "tue", label: "火", dow: 2, flagHeader: "火", baseHeader: "火曜基準値" },
  { key: "wed", label: "水", dow: 3, flagHeader: "水", baseHeader: "水曜基準値" },
  { key: "thu", label: "木", dow: 4, flagHeader: "木", baseHeader: "木曜基準値" },
  { key: "fri", label: "金", dow: 5, flagHeader: "金", baseHeader: "金曜基準値" },
  { key: "sat", label: "土", dow: 6, flagHeader: "土", baseHeader: "土曜基準値" },
  { key: "sun", label: "日", dow: 0, flagHeader: "日", baseHeader: "日曜基準値" },
];

// 「予測の方法」のうち「天気で自動計算」が選べる店舗（天気・気温による調整式がコードに
// 用意されている店舗）。それ以外の店舗（Rozengracht等）は「固定数」のみ選べる。
const FORECAST_METHOD_CAPABLE_STORES = ["Zuid", "UvA"];

// 「店舗設定」シートに値が無い（店舗の行自体が無い、またはその曜日のセルだけ空欄）場合に
// 使う既定値。Zuid・UvAはこれまでコードに埋め込まれていた固定値（旧ZUID_SEASON_BASE.autumnの
// 値／UvAの旧固定35個）、Rozengrachtはオープン時点の初期値（旧「平日基本数100・土日基本数150」を
// 月〜金100・土日150の曜日ごとの値に置き換えたもの）。管理画面から一度でも保存すれば、
// 以降はスプレッドシート側の値が優先される。
// getStoreWeekdayBase()は、店舗の行自体が無い場合だけでなく、行はあっても特定の曜日の
// 基準値・販売数だけが空欄の場合にも、その曜日だけこの既定値にフォールバックする
// （店舗ごとまるごとではなく、曜日ごとに細かくフォールバックする）。
const DEFAULT_STORE_SETTINGS = {
  Zuid: {
    weekdayBase: { mon: 95, tue: 120, wed: 110, thu: 120, fri: 95, sat: null, sun: null },
  },
  UvA: {
    weekdayBase: { mon: 35, tue: 35, wed: null, thu: 35, fri: null, sat: null, sun: null },
  },
  Rozengracht: {
    startDate: "2026-11-09",
    endDate: "2027-04-30",
    weekdays: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true },
    forecastMethod: "fixed",
    weekdayBase: { mon: 100, tue: 100, wed: 100, thu: 100, fri: 100, sat: 150, sun: 150 },
  },
};

// "yyyy-MM-dd"形式、または以前gviz経由で保存され日付型セルに自動変換されてしまった古い
// 表示（"2026/11/9"等）にも対応する。空文字はそのまま返す（未設定）。
// それ以外の読めない文字列はnullを返す（呼び出し側で警告表示に使う）。
function parseStoreSettingsDateText(text){
  if(!text) return "";
  if(/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const m = text.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if(m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return null;
}

// Code.gs(type=storeSettings)から「店舗設定」シートの表示値（2次元配列）を取得する。
// 取得に失敗した場合は空配列を返す（parseStoreSettingsRowsは空配列から空のsettingsを返すため、
// 呼び出し側は「まだ一度も保存されていない＝全店舗、期間制限なし」と同じ扱いになる）。
async function fetchStoreSettingsRows(scriptUrl){
  try{
    const res = await fetch(`${scriptUrl}?type=storeSettings`, { cache: "no-store" });
    const json = await res.json();
    if(json && json.error) throw new Error(json.error);
    return json.rows || [];
  }catch(e){
    console.error("店舗設定の取得に失敗しました", e);
    return [];
  }
}

// Code.gs(type=storeSettings)が返す表示文字列の2次元配列（1行目はヘッダー）を解析する。
// 戻り値: { settings: {店舗名: {startDate,endDate,weekdays,weekdayQty,weekendQty,weekdayBase}},
//           warnings: [表示用の警告文字列, ...] }
// 空欄のセルは「未設定」として黙ってnull/既定値扱いにする（これは正常な状態）。
// warningsは、値が入っているのに日付・数値として読み取れなかったセルがある場合にだけ積む
// （店舗の営業設定を確認するよう、画面上部に表示する）。
function parseStoreSettingsRows(rows){
  const settings = {};
  const warnings = [];
  if(!rows || rows.length < 1) return { settings, warnings };

  const header = rows[0] || [];
  const colIndexByHeader = {};
  header.forEach((h, i) => { colIndexByHeader[String(h).trim()] = i; });

  const cellOf = row => headerName => {
    const idx = colIndexByHeader[headerName];
    if(idx === undefined || row[idx] === undefined || row[idx] === null) return "";
    return String(row[idx]).trim();
  };

  for(let r = 1; r < rows.length; r++){
    const row = rows[r] || [];
    const cell = cellOf(row);
    const store = cell("店舗名");
    if(!store) continue;

    const startDate = parseStoreSettingsDateText(cell("開始日"));
    if(startDate === null) warnings.push(`${store}の「開始日」の値を読み取れませんでした（店舗の営業設定を確認してください）`);
    const endDate = parseStoreSettingsDateText(cell("終了日"));
    if(endDate === null) warnings.push(`${store}の「終了日」の値を読み取れませんでした（店舗の営業設定を確認してください）`);

    const weekdays = {};
    STORE_SETTINGS_WEEKDAYS.forEach(wd => {
      // 空欄・読めない値は「営業」として扱う。明示的に"FALSE"（大文字小文字・前後の空白は
      // 無視）のときだけ休業とする（設定画面の説明どおり：チェック無し＝全曜日営業）
      weekdays[wd.key] = cell(wd.flagHeader).toUpperCase() !== "FALSE";
    });

    const numOrNull = (text, label) => {
      if(text === "") return null;
      const n = Number(text);
      if(!Number.isFinite(n)){
        warnings.push(`${store}の「${label}」の値（${text}）を数値として読み取れませんでした（店舗の営業設定を確認してください）`);
        return null;
      }
      return n;
    };

    const weekdayBase = {};
    STORE_SETTINGS_WEEKDAYS.forEach(wd => {
      weekdayBase[wd.key] = numOrNull(cell(wd.baseHeader), wd.baseHeader);
    });

    // 「予測の方法」：「固定数」「天気で自動計算」のどちらでもない値（空欄含む）は
    // 未設定として扱い、getStoreForecastMethod()が店舗ごとの既定（Zuid/UvAは天気で
    // 自動計算、それ以外は固定数）にフォールバックする。
    const methodText = cell("予測の方法");
    const forecastMethod = methodText === "固定数" ? "fixed" : methodText === "天気で自動計算" ? "weather" : "";

    settings[store] = {
      startDate: startDate || "",
      endDate: endDate || "",
      weekdays,
      forecastMethod,
      weekdayBase,
    };
  }
  return { settings, warnings };
}

// storeSettings: parseStoreSettingsRows()が返したsettings（店舗名 -> 設定）。
// 設定行が無い店舗は既定値（DEFAULT_STORE_SETTINGS）、どちらも無ければnullを返す
// （isStoreOperatingOnはnullを「期間制限なし・全曜日営業」として扱う）。
function getStoreConfig(storeSettings, store){
  return (storeSettings && storeSettings[store]) || DEFAULT_STORE_SETTINGS[store] || null;
}

// 指定した店舗が、その日（iso・dow）に営業しているかを判定する。
// 設定が無い・空欄の項目は「期間制限なし・営業」として扱う（既存店舗は設定するまで
// これまでの動きと変わらない）。
function isStoreOperatingOn(config, iso, dow){
  if(!config) return true;
  if(config.startDate && iso < config.startDate) return false;
  if(config.endDate && iso > config.endDate) return false;
  const wdEntry = STORE_SETTINGS_WEEKDAYS.find(wd => wd.dow === dow);
  if(wdEntry && config.weekdays && config.weekdays[wdEntry.key] === false) return false;
  return true;
}

// 指定した店舗・曜日の「曜日ごとの基準値／固定数」を返す（「予測の方法」が天気で自動計算の
// 店舗ではこの値に気温・天気による調整をかけ、固定数の店舗ではこの値をそのまま予測数にする）。
// 「店舗設定」シートにその曜日の値が無い場合は、既定値（DEFAULT_STORE_SETTINGS）の同じ曜日の
// 値にフォールバックする（店舗の行自体が無い場合だけでなく、行はあっても特定の曜日だけ
// 空欄の場合も、その曜日だけ既定値を使う）。既定値も無ければその曜日は休業扱い（null）。
// 読み取った値・既定値のどちらについても、数値として不正（非有限）な場合は必ずnullを返す
// （呼び出し側にNaNを一切渡さないための最終防御）。
function getStoreWeekdayBase(storeSettings, store, dow){
  const wdEntry = STORE_SETTINGS_WEEKDAYS.find(wd => wd.dow === dow);
  if(!wdEntry) return null;
  const config = storeSettings && storeSettings[store];
  let v = (config && config.weekdayBase) ? config.weekdayBase[wdEntry.key] : null;
  if(v === null || v === undefined || v === ""){
    const defaults = DEFAULT_STORE_SETTINGS[store];
    v = (defaults && defaults.weekdayBase) ? defaults.weekdayBase[wdEntry.key] : null;
  }
  if(v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---------- 推奨数算出（予報範囲外にも対応） ---------- */
// calcZuid/calcUvAは、呼び出し元のページがグローバルに定義しているDAY_NAMES
// （["日","月","火","水","木","金","土"]。admin.html・index.htmlで同じ値を定義済み）を参照する。

function isRainCode(code){
  return [51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99].includes(code);
}

function weatherCategory(code){
  if(code === 0 || code === 1) return "晴れ";
  if(isRainCode(code)) return "雨";
  return "曇り";
}

function tempAdjustment(temp){
  if(temp <= 15) return { adj: -15, label: "15℃以下" };
  if(temp <= 17) return { adj: -5, label: "16〜17℃" };
  if(temp <= 24) return { adj: 10, label: "18〜24℃" };
  if(temp <= 28) return { adj: 0, label: "25〜28℃" };
  return { adj: -10, label: "29℃以上" };
}

// baseOverride（getStoreWeekdayBase()の戻り値）がnullの場合は「その曜日は休業」として
// nullを返す。baseOverrideは既にgetStoreWeekdayBase側でNaNにならないことが保証されている。
function calcZuid(dow, salesWeather, baseOverride){
  if(baseOverride === null || baseOverride === undefined || baseOverride === "") return null;

  let total = Number(baseOverride);
  const reasons = [`${DAY_NAMES[dow]}曜ベース ${total}個`];

  if(!salesWeather){
    reasons.push("予報範囲外のため気温・天気補正なし");
    const ZUID_MIN_NF = 100;
    if(total < ZUID_MIN_NF){ total = ZUID_MIN_NF; reasons.push(`最低保証 ${ZUID_MIN_NF}個 を適用`); }
    return { total, reasons };
  }

  const { adj: tempAdj, label: tempLabel } = tempAdjustment(salesWeather.avgTemp);
  total += tempAdj;
  reasons.push(`気温${tempLabel}(11-15時平均) ${tempAdj >= 0 ? "+" : ""}${tempAdj}`);

  if(salesWeather.hasRainGeneral){
    total -= 20;
    reasons.push("販売時間帯(11〜15時)に雨 -20");
  } else if(weatherCategory(salesWeather.code) === "晴れ"){
    total += 5;
    reasons.push("晴れ +5");
  } else if(weatherCategory(salesWeather.code) === "雨"){
    reasons.push("販売時間帯外の雨のみ 天気補正なし");
  } else {
    reasons.push("曇り ±0");
  }

  const ZUID_MIN = 100;
  if(total < ZUID_MIN){
    total = ZUID_MIN;
    reasons.push(`最低保証 ${ZUID_MIN}個 を適用`);
  }

  return { total, reasons };
}

function calcUvA(dow, salesWeather, baseOverride){
  if(baseOverride === null || baseOverride === undefined || baseOverride === "") return null;
  let total = Number(baseOverride);
  const reasons = [`${DAY_NAMES[dow]}曜ベース ${total}個`];

  if(salesWeather && salesWeather.avgTemp >= 18 && salesWeather.avgTemp <= 24){
    total += 5;
    reasons.push("気温18〜24℃ +5");
  }

  if(salesWeather && salesWeather.hasRainGeneral){ total -= 10; reasons.push("販売時間帯(11〜14時)に雨 -10"); }

  const UVA_MIN = 25;
  if(total < UVA_MIN){
    total = UVA_MIN;
    reasons.push(`最低保証 ${UVA_MIN}個 を適用`);
  }

  return { total, reasons };
}

// 店舗の「予測の方法」を返す（"weather"=天気で自動計算 / "fixed"=固定数）。
// 店舗設定シートに明示的な保存値が無い場合は、店舗ごとの既定にフォールバックする
// （Zuid・UvAは天気で自動計算、天気の調整式を持たないそれ以外の店舗は固定数）。
function getStoreForecastMethod(storeSettings, store){
  const config = storeSettings && storeSettings[store];
  if(config && (config.forecastMethod === "weather" || config.forecastMethod === "fixed")){
    // 天気の調整式が無い店舗では「天気で自動計算」を選べない（UIでも選択肢を出さない）ため、
    // 保存データが古い・手動編集などで"weather"になっていても、安全に固定数として扱う
    if(config.forecastMethod === "weather" && !FORECAST_METHOD_CAPABLE_STORES.includes(store)) return "fixed";
    return config.forecastMethod;
  }
  return FORECAST_METHOD_CAPABLE_STORES.includes(store) ? "weather" : "fixed";
}

// 店舗・日付・曜日・（天気で自動計算の店舗向けに）販売時間帯の天気から、その日の予測数を
// 1つの関数で算出する。admin.html・index.htmlはどちらもこの関数だけを呼べばよく、
// 店舗ごとの計算式の呼び分け・営業設定の重ね適用を個別に書く必要が無い
// （以前はこれらをページごとに別々に組み立てていたため、判定が食い違う不具合があった）。
// 休業（null）：営業期間・営業曜日の対象外の日、またはその曜日の基準値/固定数が
// 読み取れない（既定値も無い）日。
function resolveStoreForecast(storeSettings, store, iso, dow, salesWeather){
  const config = getStoreConfig(storeSettings, store);
  if(!isStoreOperatingOn(config, iso, dow)) return null;
  const base = getStoreWeekdayBase(storeSettings, store, dow);
  if(base === null) return null;

  const method = getStoreForecastMethod(storeSettings, store);
  if(method === "fixed"){
    return { total: base, reasons: [`固定数 ${base}個`] };
  }
  if(store === "Zuid") return calcZuid(dow, salesWeather, base);
  if(store === "UvA") return calcUvA(dow, salesWeather, base);
  // 天気の調整式を持たない店舗が誤って"weather"になっていた場合の最終防御（通常は
  // getStoreForecastMethod()側で"fixed"に落とされるため、ここには来ない）
  return { total: base, reasons: [`固定数 ${base}個`] };
}
