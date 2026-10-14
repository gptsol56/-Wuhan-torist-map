// Prometheus 兼容 /metrics 端点
const express = require('express');
const m = require('../lib/metrics');

const router = express.Router();

router.get('/', (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(m.render());
});

module.exports = router;