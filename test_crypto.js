const crypto = require('crypto');
try {
  const secret = '';
  const hash = crypto.createHmac('sha256', secret).update('test').digest('base64');
  console.log('No throw:', hash);
} catch(e) {
  console.log('Threw error:', e.message);
}
