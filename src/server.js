const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const app = createApp();

app.listen(port, host, () => {
  console.log(`자료실 서버가 http://${host}:${port} 에서 실행 중입니다.`);
  console.log(`자료 폴더: ${process.env.DATA_DIR || 'data'}`);
});
