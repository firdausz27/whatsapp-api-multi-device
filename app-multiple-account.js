const { Client, MessageMedia, LocalAuth, Buttons, List } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const { body, validationResult } = require('express-validator');
const fileUpload = require('express-fileupload');
const axios = require('axios');
var koneksi = require('./koneksi');
const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

/**
 * BASED ON MANY QUESTIONS
 * Actually ready mentioned on the tutorials
 * 
 * The two middlewares above only handle for data json & urlencode (x-www-form-urlencoded)
 * So, we need to add extra middleware to handle form-data
 * Here we can use express-fileupload
 */
app.use(fileUpload({
  debug: false
}));

app.get('/', (req, res) => {
  res.sendFile('index-multiple-account.html', {
    root: __dirname
  });
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function () {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch (err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function (sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function (err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function () {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

const createSession = function (id, description) {
  console.log('Creating session: ' + id);
  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: id
    })
  });

  client.initialize();

  client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
      io.emit('qr', { id: id, src: url });
      io.emit('message', { id: id, text: 'QR Code received, scan please!' });
    });
  });

  client.on('ready', () => {
    io.emit('ready', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is ready!' });

    console.log(id + ': WA ready !!');
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);
  });

  client.on('authenticated', () => {
    io.emit('authenticated', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is authenticated!' });
  });

  client.on('auth_failure', function () {
    io.emit('message', { id: id, text: 'Auth failure, restarting...' });
  });

  client.on('disconnected', (reason) => {
    io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });
    client.destroy();
    client.initialize();

    // Menghapus pada file sessions
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions.splice(sessionIndex, 1);
    setSessionsFile(savedSessions);

    io.emit('remove-session', id);
  });

  // Tambahkan client ke sessions
  sessions.push({
    id: id,
    description: description,
    client: client
  });

  // Menambahkan session ke file
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      description: description,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }
}

const init = function (socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      /**
       * At the first time of running (e.g. restarting the server), our client is not ready yet!
       * It will need several time to authenticating.
       * 
       * So to make people not confused for the 'ready' status
       * We need to make it as FALSE for this condition
       */
      savedSessions.forEach((e, i, arr) => {
        arr[i].ready = false;
      });

      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.description);
      });
    }
  }
}

init();

// Socket IO
io.on('connection', function (socket) {
  init(socket);

  socket.on('create-session', function (data) {
    console.log('Create session: ' + data.id);
    createSession(data.id, data.description);

    var sql = `INSERT INTO tbl_user (id_user, deskripsi) VALUES ('${data.id}', '${data.description}')`;
    koneksi.query(sql, function (err, result) {
      if (err) throw err;
      console.log("1 data berhasil diinput");
    });
  });
});

// Send message
app.post('/kirim-pesan', async (req, res) => {
  // console.log(req);

  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

  const client = sessions.find(sess => sess.id == sender)?.client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }

  /**
   * Check if the number is already registered
   * Copied from app.js
   * 
   * Please check app.js for more validations example
   * You can add the same here!
   */
  const isRegisteredNumber = await client.isRegisteredUser(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered'
    });
  }

  client.sendMessage(number, message).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

// kirim ke grup
app.post('/kirim-pesan-grup', [
  body('id').custom((value, { req }) => {
    if (!value && !req.body.name) {
      throw new Error('Invalid value, you can use `id` or `name`');
    }
    return true;
  }),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({
    msg
  }) => {
    return msg;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped(),
    });
  }

  const sender = req.body.sender;
  const client = sessions.find(sess => sess.id == sender)?.client;

  let chatId = req.body.id;
  const groupName = req.body.name;
  const message = req.body.message;

  // Find the group by name
  if (!chatId) {
    const group = await findGroupByName(groupName);
    if (!group) {
      return res.status(422).json({
        status: false,
        message: 'No group found with name: ' + groupName
      });
    }
    chatId = group.id._serialized;
  }

  client.sendMessage(chatId, message).then(response => {
    if (res.status(200)) {
      console.log('Sukses');
    }
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

// Send media
app.post('/send-media', async (req, res) => {
  const sender = req.body.sender;
  const client = sessions.find(sess => sess.id == sender)?.client;
  const number = phoneNumberFormatter(req.body.number);
  const caption = req.body.caption;
  const fileUrl = req.body.file;

  // const media = MessageMedia.fromFilePath('./image-example.png');
  // const file = req.files.file;
  // const media = new MessageMedia(file.mimetype, file.data.toString('base64'), file.name);
  let mimetype;
  const attachment = await axios.get(fileUrl, {
    responseType: 'arraybuffer'
  }).then(response => {
    mimetype = response.headers['content-type'];
    return response.data.toString('base64');
  });

  const media = new MessageMedia(mimetype, attachment, 'Media');

  client.sendMessage(number, media, {
    caption: caption
  }).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

function zeroPad(num) {
  return num.toString().padStart(2, "0");
}

function now() {
  let date_time = new Date();
  let date = ("0" + date_time.getDate()).slice(-2);
  let month = ("0" + (date_time.getMonth() + 1)).slice(-2);
  let year = date_time.getFullYear();
  let hours = date_time.getHours();
  let minutes = date_time.getMinutes();
  let seconds = date_time.getSeconds();
  // prints date & time in YYYY-MM-DD HH:MM:SS format
  let newDate = year + "-" + month + "-" + date + " " + zeroPad(hours) + ":" + zeroPad(minutes) + ":" + zeroPad(seconds);
  return newDate;
}

app.get('/kontak', async (req, res) => {
  const sender = '123';
  const client = sessions.find(sess => sess.id == sender)?.client;

  client.getContacts().then(response => {

    var no = 0;
    for (var i = 0; i < response.length; i++) {
      if (response[i].id['server'] == 'c.us' && response[i].number != null && response[i].name != null) {
        console.log(response[i].number);
        var number = response[i].number;
        var nama = response[i].name;
        nama = nama.replace("'", "");

        var sql = "INSERT INTO tbl_contacts (id_user, number, nama, aktif, date_input) VALUES ('" + sender + "', '" + number + "','" + nama + "','Y','" + now() + "')";
        koneksi.query(sql, function (err, result) {
          if (err) throw err;
          console.log(number + ": berhasil diinput");
        });
        no++;
      }
    }

    res.status(200).json({
      status: true,
      data: no
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

app.get('/test-btn', async (req, res) => {
  const sender = '123';
  const client = sessions.find(sess => sess.id == sender)?.client;

  const TEST_JID = '62895608266103@c.us'; // modify
  // const TEST_GROUP = 'GROUP_ID'; // modify
  const buttons_reply = new Buttons('test', [{ body: 'Test', id: 'test-1' }], 'title', 'footer') // Reply button

  const buttons_reply_url = new Buttons('test', [{ body: 'Test', id: 'test-1' }, { body: "Test 2", url: "https://wwebjs.dev" }], 'title', 'footer') // Reply button with URL

  const buttons_reply_call = new Buttons('test', [{ body: 'Test', id: 'test-1' }, { body: "Test 2 Call", url: "+1 (234) 567-8901" }], 'title', 'footer') // Reply button with call button

  const buttons_reply_call_url = new Buttons('test', [{ body: 'Test', id: 'test-1' }, { body: "Test 2 Call", url: "+1 (234) 567-8901" }, { body: 'Test 3 URL', url: 'https://wwebjs.dev' }], 'title', 'footer') // Reply button with call button & url buttons ya

  const section = {
    title: 'test',
    rows: [
      {
        title: 'Test 1',
      },
      {
        title: 'Test 2',
        id: 'test-2'
      },
      {
        title: 'Test 3',
        description: 'This is a smaller text field, a description'
      },
      {
        title: 'Test 4',
        description: 'This is a smaller text field, a description',
        id: 'test-4',
      }
    ],
  };

  // send to test_jid
  for (const component of [buttons_reply, buttons_reply_url, buttons_reply_call, buttons_reply_call_url]) await client.sendMessage(TEST_JID, component);

  // send to test_group
  // for (const component of [buttons_reply, buttons_reply_url, buttons_reply_call, buttons_reply_call_url]) await client.sendMessage(TEST_GROUP, component);

  const list = new List('test', 'click me', [section], 'title', 'footer')
  client.sendMessage(TEST_JID, list);
  // await client.sendMessage(TEST_GROUP, list);
});

server.listen(port, function () {
  console.log('App running on *: ' + port);
});
