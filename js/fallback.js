// fallback.js — 启动前检查（普通脚本，在 file:// 下也能运行）
// 文案集中在本字典里，视图文件只提供空的容器节点。
(function () {
  var TEXT = {
    fileProtocol: {
      title: '请通过本地 HTTP 服务打开',
      body: '浏览器在 file:// 方式下会拦截 ES 模块与数据请求，页面无法启动。',
      how: '在 highway-corridor-lod 目录执行：python3 -m http.server 8125，然后打开 http://127.0.0.1:8125',
    },
    notBooted: {
      title: '页面没有启动',
      body: '模块或数据没有就绪，可能是服务未启动、端口被占用或网络不可用。',
      how: '确认已用本地 HTTP 服务打开，并查看浏览器控制台的报错。',
    },
  };

  function render(kind) {
    var box = document.getElementById('bootNotice');
    if (!box) return;
    var t = TEXT[kind];
    box.innerHTML = '';
    var h = document.createElement('h1');
    h.textContent = t.title;
    var p = document.createElement('p');
    p.textContent = t.body;
    box.appendChild(h);
    box.appendChild(p);
    if (t.how) {
      var pre = document.createElement('pre');
      pre.textContent = t.how;
      box.appendChild(pre);
    }
    box.hidden = false;
    box.setAttribute('data-kind', kind);
  }

  if (location.protocol === 'file:') {
    render('fileProtocol');
    return;
  }
  window.setTimeout(function () {
    if (!window.__lod) render('notBooted');
  }, 6000);
  window.addEventListener('lod:ready', function () {
    var box = document.getElementById('bootNotice');
    if (box) box.hidden = true;
  });
})();
