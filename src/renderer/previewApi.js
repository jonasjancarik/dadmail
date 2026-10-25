// Development only: when the UI is opened in a normal browser (npm run preview:ui),
// this stands in for the Rust backend with made-up emails, so the design can be
// checked without the app or a real mailbox. Never used in the built app.

export function createPreviewApi() {
  const now = Math.floor(Date.now() / 1000);
  const hour = 3600;
  const day = 24 * hour;

  const SAMPLES = [
    ['Petr Novák', 'petr.novak@email.cz', 'Fotky z víkendu', 'Ahoj tati, posílám fotky z chaty. Děti se moc těšily, příště jedeme zase.', 2 * hour, false, ['chata-1.jpg', 'chata-2.jpg']],
    ['Lékárna U Zlaté váhy', 'objednavky@lekarna-zlatavaha.cz', 'Vaše objednávka je připravena k vyzvednutí', 'Dobrý den, vaše objednávka č. 48 213 je připravena na pobočce Husova 12.', 5 * hour, false],
    ['Obecní úřad Lhota', 'podatelna@lhota-obec.cz', 'Svoz velkoobjemového odpadu v sobotu', 'Vážení občané, v sobotu 8. listopadu proběhne svoz velkoobjemového odpadu.', 1 * day, true],
    ['Jana Dvořáková', 'jana.dvorakova@seznam.cz', 'Re: Narozeniny maminky', 'Tak to bude super, dort zajistím já. Přijedete v neděli kolem druhé?', 1 * day + 3 * hour, true],
    ['Banka – bezpečnost info@moje-banka.cz', 'alert@secure-login-update.ru', 'Ověřte prosím svůj účet', 'Váš účet bude zablokován, pokud do 24 hodin neověříte své údaje.', 2 * day, false],
    ['Energie Plus', 'faktury@energieplus.cz', 'Vyúčtování za říjen', 'V příloze zasíláme vyúčtování elektřiny za říjen. Částka 1 847 Kč bude stržena 15. 11.', 3 * day, true, ['vyuctovani-rijen.pdf']],
    ['Sousedská zahrada', 'novinky@sousedska-zahrada.cz', 'Podzimní výsadba: co ještě stihnout', 'Česnek, tulipány a ovocné stromky. Přinášíme pár tipů na poslední teplé dny.', 4 * day, true],
    ['Tomáš Kučera', 'tomas.kucera@centrum.cz', 'Šachy ve čtvrtek?', 'Ahoj Jirko, platí čtvrtek v klubovně? Vezmu novou šachovnici.', 5 * day, true],
  ];

  const emails = Array.from({ length: 64 }, (_, i) => {
    const [from_name, from_addr, subject, text, age, read, attachments = []] = SAMPLES[i % SAMPLES.length];
    return {
      id: i + 1,
      from_name,
      from_addr,
      subject: i < SAMPLES.length ? subject : `${subject} (${Math.floor(i / SAMPLES.length) + 1})`,
      preview: text,
      body_text: `${text}\n\nS pozdravem\n${from_name}`,
      body_html:
        i % SAMPLES.length === 6
          ? `<p>${text}</p><p><img src="https://picsum.photos/seed/zahrada/600/240" alt="Zahrada"></p><p><a href="https://example.com">Číst celý článek</a></p>`
          : '',
      to_addr: 'jiri@seznam.cz',
      folder: 'inbox',
      date: now - age - Math.floor(i / SAMPLES.length) * 7 * day,
      is_read: read || i >= SAMPLES.length ? 1 : 0,
      attachments: attachments.map((file_name, index) => ({ index, file_name, size: 180000 + index * 92000, risky: false })),
    };
  });

  // A few sent and deleted emails for the other folders
  emails.push(
    { id: 101, folder: 'sent', from_name: 'Jiří Novák', from_addr: 'jiri@seznam.cz', to_addr: 'petr.novak@email.cz', subject: 'Re: Fotky z víkendu', preview: 'Děkuji, moc hezké. Babička má radost.', body_text: 'Děkuji, moc hezké. Babička má radost.\n\nTáta', body_html: '', date: now - 3 * hour, is_read: 1, attachments: [] },
    { id: 102, folder: 'sent', from_name: 'Jiří Novák', from_addr: 'jiri@seznam.cz', to_addr: 'tomas.kucera@centrum.cz', subject: 'Re: Šachy ve čtvrtek?', preview: 'Platí, budu tam v šest.', body_text: 'Platí, budu tam v šest.', body_html: '', date: now - 4 * day, is_read: 1, attachments: [] },
    { id: 103, folder: 'trash', from_name: 'Výprodej Plus', from_addr: 'akce@vyprodej-plus.cz', to_addr: 'jiri@seznam.cz', subject: 'Sleva 40 % jen dnes', preview: 'Nenechte si ujít naši největší akci roku.', body_text: 'Nenechte si ujít naši největší akci roku.', body_html: '', date: now - 2 * day, is_read: 1, attachments: [] },
  );
  let draft = null;

  const listItem = ({ body_text, body_html, attachments, ...rest }) => rest;
  const settings = { email: 'jiri@seznam.cz', has_password: '1', zoom: '1' };
  const ok = (extra = {}) => Promise.resolve({ success: true, ...extra });

  return {
    getEmails: async (folder = 'inbox', query = '') => {
      const q = query.trim().toLowerCase();
      return emails
        .filter((e) => e.folder === folder && (!q || `${e.subject} ${e.from_name} ${e.body_text}`.toLowerCase().includes(q)))
        .sort((a, b) => b.date - a.date)
        .map(listItem);
    },
    getEmail: async (id) => {
      const email = emails.find((e) => e.id === id);
      email.is_read = 1;
      return { ...email };
    },
    deleteEmail: async (id) => {
      emails.find((e) => e.id === id).folder = 'trash';
      return ok();
    },
    restoreEmail: async (id) => {
      emails.find((e) => e.id === id).folder = 'inbox';
      return ok();
    },
    markUnread: async (id) => {
      emails.find((e) => e.id === id).is_read = 0;
      return ok();
    },
    folderCounts: async () =>
      Object.fromEntries(['inbox', 'sent', 'trash'].map((f) => [f, emails.filter((e) => e.folder === f && !e.is_read).length])),
    getContacts: async () => [
      { name: 'Petr Novák', address: 'petr.novak@email.cz' },
      { name: 'Jana Dvořáková', address: 'jana.dvorakova@seznam.cz' },
      { name: 'Tomáš Kučera', address: 'tomas.kucera@centrum.cz' },
    ],
    getDraft: async () => draft,
    saveDraft: async (d) => {
      draft = d;
    },
    pickFiles: async () => [{ path: '/Users/ukazka/Obrazky/zahrada.jpg', name: 'zahrada.jpg', size: 2310000 }],
    getSettings: async () => ({ ...settings }),
    saveSettings: async (s) => {
      Object.assign(settings, s);
      return ok();
    },
    sendEmail: () => ok(),
    testConnection: () => ok(),
    onEmailsUpdated: () => () => {},
    onSyncStatus: () => () => {},
    clearEmails: () => ok(),
    reprocessEmails: () => ok({ processed: emails.length }),
    openLink: (url) => {
      window.open(url, '_blank');
      return ok();
    },
    setZoom: async (zoom) => {
      document.documentElement.style.zoom = zoom;
      settings.zoom = String(zoom);
      return zoom;
    },
    checkForUpdate: async () => '0.2.0',
    syncNow: async () => {},
    installUpdate: () => ok(),
    openAttachment: () => ok(),
    saveAttachment: (emailId, index) => ok({ fileName: emails.find((e) => e.id === emailId).attachments[index].file_name }),
  };
}
