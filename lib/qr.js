// Платёжный QR-код по ГОСТ Р 56042-2014 — его распознают приложения всех банков РФ
const QRCode = require('qrcode');

const clean = (v) => String(v ?? '').replace(/[|\r\n]/g, ' ').trim();

function paymentString(ip, { sum, purpose, payer }) {
  const fields = [
    'ST00012',
    `Name=${clean(ip.full_name)}`,
    `PersonalAcc=${clean(ip.account)}`,
    `BankName=${clean(ip.bank_name)}`,
    `BIC=${clean(ip.bik)}`,
    `CorrespAcc=${clean(ip.corr_account)}`,
    `PayeeINN=${clean(ip.inn)}`,
  ];
  if (sum) fields.push(`Sum=${Math.round(sum)}`); // в копейках
  if (purpose) fields.push(`Purpose=${clean(purpose)}`);
  if (payer) fields.push(`lastName=${clean(payer.last_name)}`, `firstName=${clean(payer.first_name)}`);
  return fields.join('|');
}

function paymentQr(ip, opts) {
  return QRCode.toDataURL(paymentString(ip, opts), { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

module.exports = { paymentQr, paymentString };
