// 腾讯地图 GL JSAPI 的全局 TMap 由 app.js 末尾动态 <script> 注入，
// 静态分析（编辑器/tsc）看不到定义，会在 app.js 里到处标红「TMap is not defined」。
// 这里补一个宽松声明：编辑器不再报错，还能拿到基础补全。
// API 结构以官方文档为准：https://lbs.qq.com/webApi/glAPI
declare var TMap: any;
