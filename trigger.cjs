const http = require('http');

const data = JSON.stringify({
  options: {
    niche: 'gadget_smartphone'
  }
});

const options = {
  hostname: '10.232.53.103',
  port: 5000,
  path: '/api/auto/start',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', (d) => {
    process.stdout.write(d);
  });
});

req.on('error', (error) => {
  console.error(error);
});

req.write(data);
req.end();
