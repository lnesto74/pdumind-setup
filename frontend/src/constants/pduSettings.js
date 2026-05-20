// Field definitions mirrored from the PDU web admin pages:
//   /sys_snmp.html  (snmp_set.cgi)
//   /sys_time.html  (time_set.cgi)

export const SNMP_AUTH_PROTOCOLS = [
  { value: '0', label: 'NONE' },
  { value: '1', label: 'MD5' },
  { value: '2', label: 'SHA' },
];

export const SNMP_PRIV_PROTOCOLS = [
  { value: '0', label: 'NONE' },
  { value: '1', label: 'DES' },
  { value: '2', label: 'AES' },
];

// Full timezone list from SNTPStatu_TimeZone in sys_time.html
export const PDU_TIMEZONES = [
  { value: '0', label: '(UTC-12) International Date Line West' },
  { value: '1', label: '(UTC-11) Coordinated Universal Time-11' },
  { value: '2', label: '(UTC-10) Hawaii' },
  { value: '3', label: '(UTC-09) Alaska' },
  { value: '4', label: '(UTC-08) Pacific Time (US & Canada)' },
  { value: '5', label: '(UTC-08) Baja California' },
  { value: '6', label: '(UTC-07) Mountain Time (US & Canada)' },
  { value: '7', label: '(UTC-07) Chihuahua, La Paz, Mazatlan' },
  { value: '8', label: '(UTC-07) Arizona' },
  { value: '9', label: '(UTC-06) Saskatchewan' },
  { value: '10', label: '(UTC-06) Central America' },
  { value: '11', label: '(UTC-06) Central Time (US & Canada)' },
  { value: '12', label: '(UTC-06) Guadalajara, Mexico City, Monterrey' },
  { value: '13', label: '(UTC-05) Eastern Time (US & Canada)' },
  { value: '14', label: '(UTC-05) Bogota, Lima, Quito, Rio Branco' },
  { value: '15', label: '(UTC-05) Indiana (East)' },
  { value: '16', label: '(UTC-05) Chetumal' },
  { value: '17', label: '(UTC-4:30) Caracas' },
  { value: '18', label: '(UTC-04) Atlantic Time (Canada)' },
  { value: '19', label: '(UTC-04) Cuiaba' },
  { value: '20', label: '(UTC-04) Georgetown, La Paz, Manaus, San Juan' },
  { value: '21', label: '(UTC-04) Asuncion' },
  { value: '22', label: '(UTC-03:30) Newfoundland' },
  { value: '23', label: '(UTC-03) Santiago' },
  { value: '24', label: '(UTC-03) Brasilia' },
  { value: '25', label: '(UTC-03) Greenland' },
  { value: '26', label: '(UTC-03) Montevideo' },
  { value: '27', label: '(UTC-03) Cayenne, Fortaleza' },
  { value: '28', label: '(UTC-03) Buenos Aires' },
  { value: '29', label: '(UTC-03) Salvador' },
  { value: '30', label: '(UTC-02) Mid-Atlantic-Old' },
  { value: '31', label: '(UTC-02) Coordinated Universal Time-02' },
  { value: '32', label: '(UTC-01) Azores' },
  { value: '33', label: '(UTC-01) Cabo Verde Is.' },
  { value: '34', label: '(UTC) Greenwich Mean Time: Dublin, Edinburgh, Lisbon' },
  { value: '35', label: '(UTC) Monrovia, Reykjavik' },
  { value: '36', label: '(UTC) Casablanca' },
  { value: '37', label: '(UTC) Coordinated Universal Time' },
  { value: '38', label: '(UTC+01) Belgrade, Bratislava, Budapest, Ljubljana, Prague' },
  { value: '39', label: '(UTC+01) Sarajevo, Skopje, Warsaw, Zagreb' },
  { value: '40', label: '(UTC+01) Brussels, Copenhagen, Madrid, Paris' },
  { value: '41', label: '(UTC+01) West Central Africa' },
  { value: '42', label: '(UTC+01) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna' },
  { value: '43', label: '(UTC+01) Windhoek' },
  { value: '44', label: '(UTC+02) Tripoli' },
  { value: '45', label: '(UTC+02) E.Europe' },
  { value: '46', label: '(UTC+02) Cairo' },
  { value: '47', label: '(UTC+02) Helsinki, Kyiv, Riga, Sofia, Tallinn, Vilnius' },
  { value: '48', label: '(UTC+02) Athens, Bucharest' },
  { value: '49', label: '(UTC+02) Jerusalem' },
  { value: '50', label: '(UTC+02) Amman' },
  { value: '51', label: '(UTC+02) Beirut' },
  { value: '52', label: '(UTC+02) Harare, Pretoria' },
  { value: '53', label: '(UTC+02) Damascus' },
  { value: '54', label: '(UTC+02) Istanbul' },
  { value: '55', label: '(UTC+03) Kuwait, Riyadh' },
  { value: '56', label: '(UTC+03) Baghdad' },
  { value: '57', label: '(UTC+03) Nairobi' },
  { value: '58', label: '(UTC+02) Kaliningrad (RTZ 1)' },
  { value: '59', label: '(UTC+03) Moscow, St. Petersburg, Volgograd (RTZ 2)' },
  { value: '60', label: '(UTC+03) Minsk' },
  { value: '61', label: '(UTC+03:30) Tehran' },
  { value: '62', label: '(UTC+04) Abu Dhabi, Muscat' },
  { value: '63', label: '(UTC+04) Baku' },
  { value: '64', label: '(UTC+04) Yerevan' },
  { value: '65', label: '(UTC+04) Tbilisi' },
  { value: '66', label: '(UTC+04) Port Louis' },
  { value: '67', label: '(UTC+04) Izhevsk, Samara (RTZ 3)' },
  { value: '68', label: '(UTC+04:30) Kabul' },
  { value: '69', label: '(UTC+05) Ekaterinburg (RTZ 4)' },
  { value: '70', label: '(UTC+05) Ashgabat, Tashkent' },
  { value: '71', label: '(UTC+05) Islamabad, Karachi' },
  { value: '72', label: '(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi' },
  { value: '73', label: '(UTC+05:30) Sri Jayawardenepura' },
  { value: '74', label: '(UTC+05:45) Kathmandu' },
  { value: '75', label: '(UTC+06) Astana' },
  { value: '76', label: '(UTC+06) Novosibirsk (RTZ 5)' },
  { value: '77', label: '(UTC+06) Dhaka' },
  { value: '78', label: '(UTC+06:30) Yangon (Rangoon)' },
  { value: '79', label: '(UTC+07) Bangkok, Hanoi, Jakarta' },
  { value: '80', label: '(UTC+07) Krasnoyarsk (RTZ 6)' },
  { value: '81', label: '(UTC+08) Beijing, Chongqing, Hong Kong, Urumqi' },
  { value: '82', label: '(UTC+08) Irkutsk (RTZ 7)' },
  { value: '83', label: '(UTC+08) Kuala Lumpur, Singapore' },
  { value: '84', label: '(UTC+08) Taipei' },
  { value: '85', label: '(UTC+08) Perth' },
  { value: '86', label: '(UTC+08) Ulaanbaatar' },
  { value: '87', label: '(UTC+09) Osaka, Sapporo, Tokyo' },
  { value: '88', label: '(UTC+09) Seoul' },
  { value: '89', label: '(UTC+09) Yakutsk (RTZ 8)' },
  { value: '90', label: '(UTC+09:30) Adelaide' },
  { value: '91', label: '(UTC+09:30) Darwin' },
  { value: '92', label: '(UTC+10) Brisbane' },
  { value: '93', label: '(UTC+10) Vladivostok (RTZ 9)' },
  { value: '94', label: '(UTC+10) Guam, Port Moresby' },
  { value: '95', label: '(UTC+10) Hobart' },
  { value: '96', label: '(UTC+10) Canberra, Melbourne, Sydney' },
  { value: '97', label: '(UTC+11) Magadan (RTZ 10)' },
  { value: '98', label: '(UTC+11) Solomon Is., New Caledonia' },
  { value: '99', label: '(UTC+12) Fiji' },
  { value: '100', label: '(UTC+12) Auckland, Wellington' },
  { value: '101', label: '(UTC+12) Coordinated Universal Time+12' },
  { value: '102', label: '(UTC+13) Nuku\'alofa' },
  { value: '103', label: '(UTC+13) Samoa' },
];

export const SNTP_CORRECTIONS = [
  { value: '0', label: 'Ignore' },
  { value: '1', label: 'Add 15 minutes' },
  { value: '2', label: 'Add 30 minutes' },
  { value: '3', label: 'Add 45 minutes' },
  { value: '4', label: 'Add 60 minutes' },
];

/** Default SNMP template matching sys_snmp.html field names / values. */
export const DEFAULT_SNMP_TEMPLATE = {
  read_community: 'public',
  write_community: 'private',
  snmpv1: false,
  snmpv2: false,
  snmpv3: true,
  snmpv3_username: 'admin',
  verify_protocol: '2',   // SHA
  auth_key: '',
  encrypt_protocol: '0',  // NONE (blank private protocol)
  priv_key: '',
  trap_ip: '',
};

/** Default NTP template matching sys_time.html. Timezone 79 = UTC+07 Bangkok. */
export const DEFAULT_NTP_TEMPLATE = {
  sntp_enabled: true,
  sntp_server: 'pool.ntp.org',
  sntp_server2: '',
  timezone: '79',
  update_interval: '24',
  correction: '0',
};

/** Web access template matching sys_http.html (http_https_set.cgi). */
export const DEFAULT_WEB_ACCESS_TEMPLATE = {
  https_http: '0',   // 0=HTTP, 1=HTTPS
  http_port: '80',
  https_port: '443',
};

export const WEB_ACCESS_MODES = [
  { value: '0', label: 'HTTP' },
  { value: '1', label: 'HTTPS' },
];

/** Join primary + secondary NTP into the single SNTPStatu_Server field the PDU accepts. */
export function combineSntpServers(primary, secondary) {
  return [primary, secondary].map(s => (s || '').trim()).filter(Boolean).join(',');
}

/** Split a combined SNTPStatu_Server value back into two UI fields. */
export function splitSntpServers(combined) {
  const parts = String(combined || '').split(',').map(s => s.trim()).filter(Boolean);
  return { primary: parts[0] || '', secondary: parts[1] || '' };
}
