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

// 「売れ行き＋天気」（直近の実績からの売れ行きの中央値×係数＋天気補正）が選べる店舗。
// v1.1ルールではZuidのみ対応（UvAは学事暦係数込みの既存の「天気で自動計算」のまま、
// Rozengrachtは「固定数」のまま＝今回変更しない）。
const TREND_METHOD_CAPABLE_STORES = ["Zuid"];

// Rozengrachtの「見込み」（炊飯の目安）で、係数を判定するチェックポイント時刻
// （時間帯別実績シートの時間帯と同じ12〜17時。18時は閉店間際のため対象外）。
const ROZEN_CLOSING_ESTIMATE_HOURS = [12, 13, 14, 15, 16, 17];

// 「売れ行き＋天気」の気温帯ビン。16℃以上は既存のtempAdjustment()と同じ境界
// （比較・継続性のため）。15℃以下は、冬の気温帯（最近は7〜14℃付近に集中）で
// 体感の差をより細かく反映できるよう4段階に分けている（0℃以下・0〜5℃・5〜10℃・10〜15℃）。
const TREND_TEMP_BINS = [
  { key: "le0", label: "0℃以下", header: "気温調整0℃以下%" },
  { key: "b0_5", label: "0〜5℃", header: "気温調整0-5℃%" },
  { key: "b5_10", label: "5〜10℃", header: "気温調整5-10℃%" },
  { key: "b10_15", label: "10〜15℃", header: "気温調整10-15℃%" },
  { key: "b16_17", label: "16〜17℃", header: "気温調整16-17℃%" },
  { key: "b18_24", label: "18〜24℃", header: "気温調整18-24℃%" },
  { key: "b25_28", label: "25〜28℃", header: "気温調整25-28℃%" },
  { key: "ge29", label: "29℃以上", header: "気温調整29℃以上%" },
];

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
    forecastMethod: "trend",
    // weekdayBaseは「売れ行き＋天気」では使わないが、直近の実績データが無い（例：開店直後・
    // 売れ行きの計算に使うデータの開始日を直近に設定した直後）場合のフォールバック用に残す
    weekdayBase: { mon: 95, tue: 120, wed: 110, thu: 120, fri: 95, sat: null, sun: null },
    // 売れ行き係数（L×この値＝売れ行きの目安）。v1.1ルールの初期値
    salesTrendCoefficient: 1.53,
    // 売れ行きの計算に使うデータの開始日（未設定＝全期間のデータを使う）
    salesTrendStartDate: "",
    // 気温調整%：2026-07-01〜2026-11-19の実績とOpen-Meteo過去天気から分析した結果。
    // 冬の気温帯（最近は7〜14℃付近）をより細かく見るため、旧「15℃以下」ビンを4段階
    // （0℃以下・0〜5℃・5〜10℃・10〜15℃）に分けて再分析した：
    //   5〜10℃  : 直前7営業日中央値からの残差の中央値-11.3%（データ11日）→ -11%
    //   10〜15℃ : 同-7.6%（データ10日）→ -8%
    //   0℃以下・0〜5℃ : 該当する実績データが無いため0%のまま（推測で数字を作らないため。
    //     このビンに当たる日の実績がたまったら、店舗設定画面で数値を入力して補ってください）
    // 他の気温帯・雨の有無は、データ不足または符号が不安定だったため0%。詳細は実装時の報告を参照。
    tempAdjPct: { le0: 0, b0_5: 0, b5_10: -11, b10_15: -8, b16_17: 0, b18_24: 0, b25_28: 0, ge29: 0 },
    rainAdjPct: 0,
    // 保証の最低数（0=保証なし）。直近2週間の実績（44〜60個、平均51個）が既存の保証100を
    // 大きく下回っているため、「売れ行き＋天気」の初期値は0（保証なし）とする
    // （ユーザー指示に基づく初期値。既存の「天気で自動計算」のZUID_MIN(100)は変更しない）
    minGuarantee: 0,
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
    // 「見込み」（炊飯の目安）の設定。ユーザー指示の初期値：
    // 閉店時刻17:00（平日・土日とも）・炊飯45分・下準備（炊けてから店頭に並ぶまで）15分・
    // 判断の締め切り14:30・1合あたり3個。
    closingTimeWeekday: "17:00",
    closingTimeWeekend: "17:00",
    riceCookMinutes: 45,
    prepMinutes: 15,
    decisionDeadline: "14:30",
    piecesPerGo: 3,
    // 見込み係数（チェックポイント時刻ごとの「最終合計÷その時点の累計売上」）：
    // 2026-11-22時点ではRozengrachtの営業開始からまだ15日分しかデータが無く、特に12〜14時台は
    // 日によって係数が0.06〜15倍とばらついて信頼できる値が出なかった（16・17時台は中央値
    // 約1.0で安定）。推測で数字を作らず、0（未設定）のまま管理者が手入力する運用とする
    // （店舗設定画面で、チェックポイントごとの実績データが5日分たまったら知らせる表示を出す）。
    riceCoefWeekday: { 12: 0, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0 },
    riceCoefWeekend: { 12: 0, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0 },
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

    // 「予測の方法」：「固定数」「天気で自動計算」「売れ行き＋天気」のどれでもない値
    // （空欄含む）は未設定として扱い、getStoreForecastMethod()が店舗ごとの既定
    // （Zuidは売れ行き＋天気、UvAは天気で自動計算、それ以外は固定数）にフォールバックする。
    const methodText = cell("予測の方法");
    const forecastMethod = methodText === "固定数" ? "fixed"
      : methodText === "天気で自動計算" ? "weather"
      : methodText === "売れ行き＋天気" ? "trend"
      : "";

    const salesTrendCoefficientText = cell("売れ行き係数");
    const salesTrendCoefficient = salesTrendCoefficientText === "" ? null : numOrNull(salesTrendCoefficientText, "売れ行き係数");
    const salesTrendStartDate = parseStoreSettingsDateText(cell("売れ行き開始日"));
    if(salesTrendStartDate === null) warnings.push(`${store}の「売れ行き開始日」の値を読み取れませんでした（店舗の営業設定を確認してください）`);

    const tempAdjPct = {};
    TREND_TEMP_BINS.forEach(b => { tempAdjPct[b.key] = numOrNull(cell(b.header), b.header); });
    const rainAdjPct = numOrNull(cell("雨調整%"), "雨調整%");
    const minGuarantee = numOrNull(cell("保証最低数"), "保証最低数");

    // Rozengrachtの「見込み」（炊飯の目安）用の列。他店舗の行では空欄のままになる
    // （getRozenClosingSettings()がDEFAULT_STORE_SETTINGS.Rozengrachtにフォールバックする）。
    const closingTimeWeekday = cell("閉店時刻(平日)");
    const closingTimeWeekend = cell("閉店時刻(土日)");
    const riceCookMinutes = numOrNull(cell("炊飯時間(分)"), "炊飯時間(分)");
    const prepMinutes = numOrNull(cell("下準備時間(分)"), "下準備時間(分)");
    const decisionDeadline = cell("判断締切時刻");
    const piecesPerGo = numOrNull(cell("1合あたりの個数"), "1合あたりの個数");
    const riceCoefWeekday = {};
    const riceCoefWeekend = {};
    ROZEN_CLOSING_ESTIMATE_HOURS.forEach(h => {
      riceCoefWeekday[h] = numOrNull(cell(`見込み係数(平日)${h}時`), `見込み係数(平日)${h}時`);
      riceCoefWeekend[h] = numOrNull(cell(`見込み係数(土日)${h}時`), `見込み係数(土日)${h}時`);
    });

    // 時間帯別実績で記録できる時間帯の範囲（店舗ごとに設定可能。未設定（空欄）の店舗は
    // resolveHourlySlots()で既定値（12時〜19時、全店舗共通）にフォールバックする）
    const hourlyStartHour = numOrNull(cell("時間帯開始時刻"), "時間帯開始時刻");
    const hourlyEndHour = numOrNull(cell("時間帯終了時刻"), "時間帯終了時刻");

    settings[store] = {
      startDate: startDate || "",
      endDate: endDate || "",
      weekdays,
      forecastMethod,
      weekdayBase,
      salesTrendCoefficient,
      salesTrendStartDate: salesTrendStartDate || "",
      tempAdjPct,
      rainAdjPct,
      minGuarantee,
      closingTimeWeekday: closingTimeWeekday || "",
      closingTimeWeekend: closingTimeWeekend || "",
      riceCookMinutes,
      prepMinutes,
      decisionDeadline: decisionDeadline || "",
      piecesPerGo,
      riceCoefWeekday,
      riceCoefWeekend,
      hourlyStartHour,
      hourlyEndHour,
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

// 店舗の「予測の方法」を返す（"trend"=売れ行き＋天気 / "weather"=天気で自動計算（基準値） /
// "fixed"=固定数）。店舗設定シートに明示的な保存値が無い場合は、店舗ごとの既定にフォールバック
// する（Zuidは売れ行き＋天気、UvAは天気で自動計算、それ以外（天気の調整式を持たない店舗）は
// 固定数）。
function getStoreForecastMethod(storeSettings, store){
  const config = storeSettings && storeSettings[store];
  const saved = config && config.forecastMethod;
  if(saved === "trend" || saved === "weather" || saved === "fixed"){
    // その方式に対応していない店舗では選べない（UIでも選択肢を出さない）ため、保存データが
    // 古い・手動編集などで対応外の方式になっていても、安全な方式にフォールバックする
    if(saved === "trend" && !TREND_METHOD_CAPABLE_STORES.includes(store)){
      return FORECAST_METHOD_CAPABLE_STORES.includes(store) ? "weather" : "fixed";
    }
    if(saved === "weather" && !FORECAST_METHOD_CAPABLE_STORES.includes(store)) return "fixed";
    return saved;
  }
  if(TREND_METHOD_CAPABLE_STORES.includes(store)) return "trend";
  return FORECAST_METHOD_CAPABLE_STORES.includes(store) ? "weather" : "fixed";
}

// 店舗の「売れ行き＋天気」関連の設定値を、保存値→既定値（DEFAULT_STORE_SETTINGS）→
// コード内フォールバックの順で解決して返す。数値として不正な値は既定にフォールバックする
// （NaNを一切後段に渡さないための防御。store-settings.js全体の方針と同じ）。
function getStoreTrendSettings(storeSettings, store){
  const config = storeSettings && storeSettings[store];
  const def = DEFAULT_STORE_SETTINGS[store] || {};

  const numOr = (v, fallback) => {
    if(v === null || v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const coefficient = numOr(config && config.salesTrendCoefficient, numOr(def.salesTrendCoefficient, 1.53));
  const startDate = (config && config.salesTrendStartDate) || def.salesTrendStartDate || "";
  const minGuarantee = numOr(config && config.minGuarantee, numOr(def.minGuarantee, 0));
  const rainAdjPct = numOr(config && config.rainAdjPct, numOr(def.rainAdjPct, 0));

  const tempAdjPct = {};
  TREND_TEMP_BINS.forEach(b => {
    const saved = (config && config.tempAdjPct) ? config.tempAdjPct[b.key] : null;
    const fallback = numOr((def.tempAdjPct) ? def.tempAdjPct[b.key] : null, 0);
    tempAdjPct[b.key] = numOr(saved, fallback);
  });

  return { coefficient, startDate, minGuarantee, tempAdjPct, rainAdjPct };
}

// 時間帯別実績の行配列（fetchHourlyData/getHourlySheetRowsの結果）から、指定店舗の
// 「14時累計」（受け取り・移動を加味した、保存時点で計算済みの値）を日付ごとに合算する
// （具材ごとの行を1日分にまとめる）。
function sumHourlyCum14ByDate(hourlyRows, store){
  const byDate = {};
  (hourlyRows || []).forEach(r => {
    if(!r || r.store !== store) return;
    const v = r.cum14;
    if(v === "" || v === null || v === undefined) return;
    const n = Number(v);
    if(!Number.isFinite(n)) return;
    byDate[r.date] = (byDate[r.date] || 0) + n;
  });
  return byDate;
}

function median(arr){
  if(!arr || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// 売れ行きの目安のL（直近営業日の14時累計の中央値）を計算する。
// asOfIso（当日）より前の日だけを対象にする（当日はまだ積算中のため使わない）。
// startDate（売れ行きの計算に使うデータの開始日）が指定されていれば、それより前の日は除く。
// 時間帯別実績が入っていない日・営業していない日は、そもそもcum14の記録が無いため
// 自然に除外される（その分、さらに前の日にさかのぼる）。
// 対象日数は最大4日。1日も無ければnullを返す（呼び出し側は基準値へのフォールバックを判断する）。
function computeSalesTrendL(hourlyRows, store, asOfIso, startDate){
  const byDate = sumHourlyCum14ByDate(hourlyRows, store);
  let dates = Object.keys(byDate).filter(d => d < asOfIso);
  if(startDate) dates = dates.filter(d => d >= startDate);
  dates.sort();
  const usedDates = dates.slice(-4);
  if(usedDates.length === 0) return null;
  return { L: median(usedDates.map(d => byDate[d])), n: usedDates.length, usedDates };
}

// 気温(11-15時平均)がどの調整%ビンに該当するかを返す（既存のtempAdjustment()と同じ境界）。
function tempAdjPctBinFor(tempAdjPct, temp){
  if(temp <= 0) return { pct: tempAdjPct.le0, label: "0℃以下" };
  if(temp <= 5) return { pct: tempAdjPct.b0_5, label: "0〜5℃" };
  if(temp <= 10) return { pct: tempAdjPct.b5_10, label: "5〜10℃" };
  if(temp <= 15) return { pct: tempAdjPct.b10_15, label: "10〜15℃" };
  if(temp <= 17) return { pct: tempAdjPct.b16_17, label: "16〜17℃" };
  if(temp <= 24) return { pct: tempAdjPct.b18_24, label: "18〜24℃" };
  if(temp <= 28) return { pct: tempAdjPct.b25_28, label: "25〜28℃" };
  return { pct: tempAdjPct.ge29, label: "29℃以上" };
}

/* ---------- Rozengrachtの「見込み」（炊飯の目安） ---------- */
// 「今日の累計売上×見込み係数＝今日の最終合計の見込み」から、閉店までに追加で必要な
// 個数・炊く合数を計算する。係数は推測で作らず、管理者が店舗設定画面で手入力する
// （データが少ない間は0=未設定のまま。この場合は目安を一切表示しない）。

// 時間帯別実績の行配列（fetchHourlyData/getHourlySheetRowsの結果）から、指定店舗・
// 指定時間（ROZEN_CLOSING_ESTIMATE_HOURS内）の累計売上／残数を日付ごとに合算する
// （sumHourlyCum14ByDateの時間を指定できる一般化版。残数(r{hour})も同じ形で合算する）。
function sumHourlyFieldByDate(hourlyRows, store, field){
  const byDate = {};
  (hourlyRows || []).forEach(r => {
    if(!r || r.store !== store) return;
    const v = r[field];
    if(v === "" || v === null || v === undefined) return;
    const n = Number(v);
    if(!Number.isFinite(n)) return;
    byDate[r.date] = (byDate[r.date] || 0) + n;
  });
  return byDate;
}
function sumHourlyCumByDate(hourlyRows, store, hour){ return sumHourlyFieldByDate(hourlyRows, store, `cum${hour}`); }
function sumHourlyRemainByDate(hourlyRows, store, hour){ return sumHourlyFieldByDate(hourlyRows, store, `r${hour}`); }

// ISO日付("yyyy-MM-dd")から平日/土日を判定する（シートの「曜日」列の表記揺れに
// 影響されないよう、日付から直接計算する）。
function weekdayGroupForIso(iso){
  const d = new Date(`${iso}T00:00:00`);
  const dow = d.getDay();
  return (dow === 0 || dow === 6) ? "weekend" : "weekday";
}

// Rozengrachtの見込み係数（平日/土日×12〜17時）それぞれについて、実績データが
// 何日分たまっているかを数える（admin.htmlの店舗設定画面の「データ蓄積」通知に使う。
// 自動で係数を計算・保存することは一切しない）。0（未入力扱い）の日は、まだ売れていない
// だけで信頼できるデータとはみなさず数えない。
function countRozenCoefficientDays(hourlyRows){
  const counts = { weekday: {}, weekend: {} };
  ROZEN_CLOSING_ESTIMATE_HOURS.forEach(h => { counts.weekday[h] = 0; counts.weekend[h] = 0; });
  ROZEN_CLOSING_ESTIMATE_HOURS.forEach(h => {
    const byDate = sumHourlyCumByDate(hourlyRows, "Rozengracht", h);
    Object.keys(byDate).forEach(iso => {
      if(byDate[iso] <= 0) return;
      counts[weekdayGroupForIso(iso)][h]++;
    });
  });
  return counts;
}

// Rozengrachtの「見込み」の設定を返す（店舗設定シートの保存値、無ければ既定値
// DEFAULT_STORE_SETTINGS.Rozengrachtにフォールバック）。
function getRozenClosingSettings(storeSettings){
  const config = storeSettings && storeSettings["Rozengracht"];
  const def = DEFAULT_STORE_SETTINGS.Rozengracht;
  const strOr = (v, fallback) => (v !== null && v !== undefined && v !== "") ? v : fallback;
  const numOr = (v, fallback) => {
    if(v === null || v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const coefMapOr = (saved, fallback) => {
    const out = {};
    ROZEN_CLOSING_ESTIMATE_HOURS.forEach(h => { out[h] = numOr(saved ? saved[h] : null, (fallback && fallback[h]) || 0); });
    return out;
  };
  return {
    closingTimeWeekday: strOr(config && config.closingTimeWeekday, def.closingTimeWeekday),
    closingTimeWeekend: strOr(config && config.closingTimeWeekend, def.closingTimeWeekend),
    riceCookMinutes: numOr(config && config.riceCookMinutes, def.riceCookMinutes),
    prepMinutes: numOr(config && config.prepMinutes, def.prepMinutes),
    decisionDeadline: strOr(config && config.decisionDeadline, def.decisionDeadline),
    piecesPerGo: numOr(config && config.piecesPerGo, def.piecesPerGo),
    riceCoefWeekday: coefMapOr(config && config.riceCoefWeekday, def.riceCoefWeekday),
    riceCoefWeekend: coefMapOr(config && config.riceCoefWeekend, def.riceCoefWeekend),
  };
}

// "HH:mm"形式の文字列を{h,m}に変換する。不正な形式ならnull。
function parseHHMM(str){
  const m = String(str || "").match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

// hours（ROZEN_CLOSING_ESTIMATE_HOURS）の中から、nowDateの直前（その時刻を含む）の
// チェックポイント時刻を返す。まだ最初のチェックポイントにも達していなければnull。
function latestHourlyCheckpoint(hours, nowDate){
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  let result = null;
  hours.forEach(h => { if(h * 60 <= nowMinutes) result = h; });
  return result;
}

// Rozengrachtの「見込み」（炊飯の目安）を計算する。
// nowDate: 現在時刻。dow: 曜日(0=日,...,6=土)。cumNow: 直近チェックポイント時点の
// 全具材合計の累計売上（まだ記録が無ければnull）。stockNow: 同時点の残数（在庫。無ければ0扱い）。
// settings: getRozenClosingSettings()の戻り値。
// 係数が未設定(0)・累計売上がまだ記録されていない場合はinsufficient:trueを返し、目安を
// 一切表示しない（自動で係数を決めたり書き換えたりしない）。
// 戻り値には、ユーザーへの表示・報告に使う計算の途中の値を全て含める。
function computeRozenClosingEstimate(settings, nowDate, dow, cumNow, stockNow){
  const isWeekend = dow === 0 || dow === 6;
  const checkpointHour = latestHourlyCheckpoint(ROZEN_CLOSING_ESTIMATE_HOURS, nowDate);
  const coefMap = isWeekend ? settings.riceCoefWeekend : settings.riceCoefWeekday;
  const coefficient = (checkpointHour !== null && coefMap) ? (coefMap[checkpointHour] || 0) : 0;

  const deadline = parseHHMM(settings.decisionDeadline);
  const closingLabel = isWeekend ? settings.closingTimeWeekend : settings.closingTimeWeekday;
  const closing = parseHHMM(closingLabel);

  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  const deadlineMinutes = deadline ? deadline.h * 60 + deadline.m : null;
  const pastDeadline = deadlineMinutes !== null && nowMinutes > deadlineMinutes;

  const readyDate = new Date(nowDate.getTime() + ((settings.riceCookMinutes || 0) + (settings.prepMinutes || 0)) * 60000);
  const closingDate = closing ? new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), closing.h, closing.m) : null;
  const hoursUntilClose = closingDate ? Math.max(0, (closingDate - readyDate) / 3600000) : null;

  const base = {
    checkpointHour, coefficient, isWeekend, pastDeadline,
    deadlineLabel: settings.decisionDeadline, closingLabel,
    readyDate, hoursUntilClose, cumNow,
    stockNow: (stockNow === null || stockNow === undefined) ? 0 : stockNow,
    piecesPerGo: settings.piecesPerGo || 3,
  };

  if(!coefficient || cumNow === null || cumNow === undefined || checkpointHour === null){
    return Object.assign(base, { insufficient: true });
  }

  const estimatedFinalTotal = Math.round(cumNow * coefficient);
  const remainingDemand = Math.max(0, estimatedFinalTotal - cumNow);
  const shortfall = Math.max(0, remainingDemand - base.stockNow);
  const goCount = Math.ceil(shortfall / base.piecesPerGo);

  return Object.assign(base, {
    insufficient: false,
    estimatedFinalTotal, remainingDemand, shortfall, goCount,
  });
}

// 「売れ行き＋天気」の予測数を計算する。trendInfo（computeSalesTrendLの戻り値）がnull
// （直近の売れ行きデータが無い）場合はnullを返し、呼び出し側（resolveStoreForecast）が
// 曜日基準値へのフォールバックを行う。
function calcSalesTrendForecast(trendInfo, salesWeather, trendSettings){
  if(!trendInfo || trendInfo.L === null || trendInfo.L === undefined) return null;

  const { coefficient, minGuarantee, tempAdjPct, rainAdjPct } = trendSettings;
  const trendVal = trendInfo.L * coefficient;
  let total = trendVal;
  const lLabel = Number.isInteger(trendInfo.L) ? String(trendInfo.L) : trendInfo.L.toFixed(1);
  const reasons = [`売れ行き L=${lLabel}×${coefficient}(${trendInfo.n}日分)=${Math.round(trendVal)}個`];

  if(salesWeather){
    const { pct: tPct, label: tLabel } = tempAdjPctBinFor(tempAdjPct, salesWeather.avgTemp);
    if(tPct){
      total += trendVal * (tPct / 100);
      reasons.push(`気温${tLabel} ${tPct >= 0 ? "+" : ""}${tPct}%`);
    } else {
      reasons.push(`気温${tLabel} 補正なし`);
    }
    if(salesWeather.hasRainGeneral){
      if(rainAdjPct){
        total += trendVal * (rainAdjPct / 100);
        reasons.push(`雨 ${rainAdjPct >= 0 ? "+" : ""}${rainAdjPct}%`);
      } else {
        reasons.push("雨 補正なし");
      }
    }
  } else {
    reasons.push("予報範囲外のため気温・天気補正なし");
  }

  total = Math.round(total);
  if(minGuarantee > 0 && total < minGuarantee){
    total = minGuarantee;
    reasons.push(`最低保証 ${minGuarantee}個 を適用`);
  }
  return { total, reasons, trendInfo };
}

// 店舗・日付・曜日・（天気で自動計算／売れ行き＋天気の店舗向けに）販売時間帯の天気から、
// その日の予測数を1つの関数で算出する。admin.html・index.htmlはどちらもこの関数だけを
// 呼べばよく、店舗ごとの計算式の呼び分け・営業設定の重ね適用を個別に書く必要が無い
// （以前はこれらをページごとに別々に組み立てていたため、判定が食い違う不具合があった）。
// trendInfo（売れ行き＋天気の店舗向け。computeSalesTrendLの戻り値）は、method="trend"
// でない店舗・直近データが不要な場合は省略してよい（undefinedのまま渡しても問題ない）。
// 休業（null）：営業期間・営業曜日の対象外の日、またはその曜日の基準値/固定数が
// 読み取れない（既定値も無い）日。
function resolveStoreForecast(storeSettings, store, iso, dow, salesWeather, trendInfo){
  const config = getStoreConfig(storeSettings, store);
  if(!isStoreOperatingOn(config, iso, dow)) return null;

  const method = getStoreForecastMethod(storeSettings, store);

  if(method === "trend"){
    const trendSettings = getStoreTrendSettings(storeSettings, store);
    const result = calcSalesTrendForecast(trendInfo, salesWeather, trendSettings);
    if(result) return result;
    // 直近の売れ行きデータが無い（開店直後、または売れ行きの計算に使うデータの開始日を
    // 直近に設定した直後など）場合は、曜日基準値（既定値）にフォールバックする
    const fallbackBase = getStoreWeekdayBase(storeSettings, store, dow);
    if(fallbackBase === null) return null;
    let total = fallbackBase;
    const reasons = [`${DAY_NAMES[dow]}曜ベース ${fallbackBase}個`, "直近の売れ行きデータが無いため基準値を使用"];
    if(trendSettings.minGuarantee > 0 && total < trendSettings.minGuarantee){
      total = trendSettings.minGuarantee;
      reasons.push(`最低保証 ${trendSettings.minGuarantee}個 を適用`);
    }
    return { total, reasons };
  }

  const base = getStoreWeekdayBase(storeSettings, store, dow);
  if(base === null) return null;

  if(method === "fixed"){
    return { total: base, reasons: [`固定数 ${base}個`] };
  }
  if(store === "Zuid") return calcZuid(dow, salesWeather, base);
  if(store === "UvA") return calcUvA(dow, salesWeather, base);
  // 天気の調整式を持たない店舗が誤って"weather"になっていた場合の最終防御（通常は
  // getStoreForecastMethod()側で"fixed"に落とされるため、ここには来ない）
  return { total: base, reasons: [`固定数 ${base}個`] };
}
