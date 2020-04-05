const
    axios = require('axios'),
    fs = require('fs'),
    fsp = fs.promises,
    path = require('path'),
    tmpfs = require('../tmpfs'),
    log = require('../log'),
    { mkdirp, rmdir, compilerText } = require('../utils'),
    child = require('child_process'),
    { CACHE_DIR, TEMP_DIR } = require('../config'),
    { FormatError, CompileError, SystemError } = require('../error'),
    { STATUS_COMPILE_ERROR, STATUS_SYSTEM_ERROR } = require('../status'),
    readCases = require('../cases'),
    judger = require('../judger');

module.exports = class AxiosInstance {
    constructor(config) {
        this.config = config;
        this.config.detail = this.config.detail || true;
        this.config.cookie = this.config.cookie || '';
        this.config.last_update_at = this.config.last_update_at || 0;
        if (!this.config.server_url.startsWith('http')) this.config.server_url = 'http://' + this.config.server_url;
        if (!this.config.server_url.endsWith('/')) this.config.server_url = this.config.server_url + '/';
    }
    async init() {
        await this.setCookie(this.config.cookie || '');
        await this.ensureLogin();
        setInterval(() => { this.axios.get('judge/noop'); }, 30000000);
    }
    async problem_data(pid, save_path, retry = 3) {
        log.info(`Getting problem data: ${this.config.host}/${pid}`);
        await this.ensureLogin();
        let tmp_file_path = path.resolve(CACHE_DIR, `download_${this.config.host}_${pid}`);
        try {
            console.log(`${this.config.server_url}/p/${pid}/data`);
            let res = await this.axios.get(`${this.config.server_url}/p/${pid}/data`, { responseType: 'stream' });
            let w = await fs.createWriteStream(tmp_file_path);
            res.data.pipe(w);
            await new Promise((resolve, reject) => {
                w.on('finish', resolve);
                w.on('error', reject);
            });
            mkdirp(path.dirname(save_path));
            await new Promise((resolve, reject) => {
                child.exec(`unzip ${tmp_file_path} -d ${save_path}`, e => {
                    if (e) reject(e);
                    else resolve();
                });
            });
            await fsp.unlink(tmp_file_path);
            await this.process_data(save_path).catch();
        } catch (e) {
            if (retry) await this.problem_data(pid, save_path, retry - 1);
            else throw e;
        }
        return save_path;
    }
    async consume(queue) {
        setInterval(async () => {
            let res = await this.axios.get('/judge/fetch');
            console.log(res.data);
            if (res.data.task)
                queue.push(new JudgeTask(this, res.data.task));
        }, 1000);
    }
    async setCookie(cookie) {
        console.log('SETTTTTTTTTTTTTTTTTTTTT', cookie);
        this.config.cookie = cookie;
        this.axios = axios.create({
            baseURL: this.config.server_url,
            timeout: 30000,
            headers: { cookie: this.config.cookie }
        });
    }
    async login() {
        log.log(`[${this.config.host}] Updating session`);
        let res = await this.axios.post('login', {
            uname: this.config.uname, password: this.config.password, rememberme: 'on'
        });
        await this.setCookie(res.headers['set-cookie'].join(';'));
    }
    async ensureLogin() {
        let res = await this.axios.get('/judge/noop');
        if (res.data.error) await this.login();
    }
    async process_data(folder) {
        let files = await fsp.readdir(folder), ini = false;
        for (let i of files)
            if (i.toLowerCase() == 'config.ini') {
                ini = true;
                await fsp.rename(`${folder}/${i}`, folder + '/config.ini');
                break;
            }
        if (ini) {
            for (let i of files)
                if (i.toLowerCase() == 'input')
                    await fsp.rename(`${folder}/${i}`, folder + '/input');
                else if (i.toLowerCase() == 'output')
                    await fsp.rename(`${folder}/${i}`, folder + '/output');
            files = await fsp.readdir(folder + '/input');
            for (let i of files)
                await fsp.rename(`${folder}/input/${i}`, `${folder}/input/${i.toLowerCase()}`);
            files = await fsp.readdir(folder + '/output');
            for (let i of files)
                await fsp.rename(`${folder}/output/${i}`, `${folder}/output/${i.toLowerCase()}`);
        }
    }
    async cache_open(pid, version) {
        console.log(this.config.host, pid);
        let file_path = path.join(CACHE_DIR, this.config.host, pid);
        if (fs.existsSync(file_path)) {
            let ver;
            try {
                ver = fs.readFileSync(path.join(file_path, 'version')).toString();
            } catch (e) { /* ignore */ }
            if (version == ver) return file_path;
            else rmdir(file_path);
        }
        mkdirp(file_path);
        await this.problem_data(pid, file_path);
        fs.writeFileSync(path.join(file_path, 'version'), version);
        return file_path;
    }
};

class JudgeTask {
    constructor(session, request) {
        this.stat = {};
        this.stat.receive = new Date();
        this.session = session;
        this.host = session.config.host;
        this.request = request;
    }
    async handle() {
        this.stat.handle = new Date();
        this.type = this.request.type;
        this.pid = this.request.pid;
        this.rid = this.request.rid;
        this.lang = this.request.lang;
        this.code = this.request.code;
        this.data = this.request.data;
        this.next = this.get_next(this);
        this.end = this.get_end(this.session, this.rid);
        this.tmpdir = path.resolve(TEMP_DIR, 'tmp', this.host, this.rid);
        this.clean = [];
        mkdirp(this.tmpdir);
        tmpfs.mount(this.tmpdir, '64m');
        log.submission(`${this.host}/${this.rid}`, { pid: this.pid });
        try {
            if (this.type == 0) await this.do_submission();
            else throw new SystemError(`Unsupported type: ${this.type}`);
        } catch (e) {
            if (e instanceof CompileError) {
                this.next({ compiler_text: compilerText(e.stdout, e.stderr) });
                this.end({ status: STATUS_COMPILE_ERROR, score: 0, time_ms: 0, memory_kb: 0 });
            } else if (e instanceof FormatError) {
                this.next({ judge_text: e.message + '\n' + JSON.stringify(e.params) });
                this.end({ status: STATUS_SYSTEM_ERROR, score: 0, time_ms: 0, memory_kb: 0 });
            } else {
                log.error(e);
                this.next({ judge_text: e.message + '\n' + e.stack + '\n' + JSON.stringify(e.params) });
                this.end({ status: STATUS_SYSTEM_ERROR, score: 0, time_ms: 0, memory_kb: 0 });
            }
        }
        for (let clean of this.clean) await clean().catch();
        tmpfs.umount(this.tmpdir);
        await rmdir(this.tmpdir);
    }
    async do_submission() {
        this.stat.cache_start = new Date();
        this.folder = await this.session.cache_open(this.pid, this.data);
        this.stat.read_cases = new Date();
        this.config = await readCases(this.folder, { detail: this.session.config.detail }, { next: this.next });
        this.stat.judge = new Date();
        await judger[this.config.type || 'default'].judge(this);
    }
    get_next(that) {
        that.nextId = 1;
        that.nextWaiting = [];
        return (data, id) => {
            data.key = 'next';
            data.rid = that.rid;
            if (id)
                if (id == that.nextId) {
                    that.session.axios.post('/judge/next', data);
                    that.nextId++;
                    let t = true;
                    while (t) {
                        t = false;
                        for (let i in that.nextWaiting)
                            if (that.nextId == that.nextWaiting[i].id) {
                                that.session.axios.post('/judge/next', that.nextWaiting[i].data);
                                that.nextId++;
                                that.nextWaiting.splice(i, 1);
                                t = true;
                            }
                    }
                } else that.nextWaiting.push({ data, id });
            else that.session.axios.post('/judge/next', data);
        };
    }
    get_end(session, rid) {
        return data => {
            data.key = 'end';
            data.rid = rid;
            log.log({
                status: data.status,
                score: data.score,
                time_ms: data.time_ms,
                memory_kb: data.memory_kb
            });
            session.axios.post('/judge/end', data);
        };
    }
}