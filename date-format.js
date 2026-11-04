// 日付＋曜日の表示形式「11/2（月）」を1か所にまとめる。タイムゾーン・夏時間の影響を
// 受けないよう、Dateオブジェクトのローカルの年月日（getMonth/getDate/getDay）だけから
// 文字列を組み立てる（UTC変換や日付文字列のparseは経由しない）。
// cooking.html・shift.html・index.html等、同じ表示形式を使う画面で共通利用する。
const WEEKDAY_LABELS_JA = ["日", "月", "火", "水", "木", "金", "土"];
function formatDateWithWeekday(d){
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY_LABELS_JA[d.getDay()]}）`;
}
