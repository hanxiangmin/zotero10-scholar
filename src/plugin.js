(function (root) {
  "use strict";
  const { Catalog, planUpdate } = root.ScholarCore;
  const Metadata = root.ScholarMetadata;
  const Search = root.ScholarSearch;
  const Publications = root.ScholarPublications;
  const Reports = root.ScholarReports;
  const Attachments = root.ScholarAttachments;
  const PREF = "extensions.zotero10scholar.";
  const LABEL = "Zotero 10 Scholar Rank";
  // Zotero awaits item observers in ascending priority order. Linter for
  // Zotero/Format Metadata uses 666 so it can clean fields after other add-ons.
  // Run the new-item lookup afterwards; this avoids both a race and retries.
  const AUTO_NOTIFIER_PRIORITY = 700;
  const REASONS = {
    "unsupported-type": "此操作不支持该条目类型", "no-data": "没有匹配的数据，保留原值",
    "manually-edited": "处理期间条目发生变化，已跳过", "existing-call-number": "已有索书号，自动模式保留",
    "unchanged": "无需更新", "read-only": "只读或订阅库", "invalid-doi": "没有有效 DOI",
    "doi-mismatch": "DOI 不一致或结果不唯一", "doi-type-mismatch": "返回的文献类型不同",
    "lookup-failed": "DOI 查询失败，保留原值", "duplicates": "疑似重复（仅提示，未合并）",
    "duplicate-check-failed": "重复检查失败", "conference-date-unverified": "会议年份缺少可靠记录，日期未覆盖",
    "update-failed": "更新失败，本批修改未保存",
    "search-insufficient": "无 DOI 且标题、作者或出版信息不足，未查询",
    "search-no-match": "未找到信息一致的可信结果，保留原值",
    "search-ambiguous": "匹配到多个可信结果，保留原值",
    "search-failed": "标题联网检索失败，保留原值",
    "pdf-existing": "已有全文附件，保留原文件", "pdf-no-source": "缺少有效 DOI 和论文网址",
    "pdf-blocked-source": "已跳过 Google 来源", "pdf-invalid-url": "下载网址无效或不允许",
    "pdf-not-found": "未找到可直接下载的 PDF", "pdf-network-failed": "网络请求失败",
    "pdf-access-limited": "需要登录、验证或网站限流，已停止本批下载",
    "pdf-too-large": "文件超过 50 MB，需手动下载", "pdf-cancelled": "下载已停止",
    "pdf-not-attempted": "本批已停止，未尝试下载", "pdf-save-failed": "附件保存失败",
    "pdf-unavailable": "当前 Zotero 缺少所需附件接口",
    "checked": "已核对", "promoted": "已更新为正式发表版本", "audit-cancelled": "已停止核对",
    "source-incomplete": "出版来源未提供全部卷期页信息", "verified": "信息已核对", "audit-failed": "本条核对或保存失败"
  };

  const plugin = {
    active: false, busy: false, currentOperation: null, menuIDs: [], pendingAuto: Promise.resolve(), status: "就绪",

    async start({ id, version, rootURI }) {
      Object.assign(this, { id, version, rootURI, active: true });
      this.resultWindows = new Set();
      this.autoResult = null;
      this.storageDir = PathUtils.join(Zotero.DataDirectory.dir, "zotero10-scholar");
      const files = [["ccf", "ccf-2026.json"], ["jcr", "jcr-2025.json"], ["cas", "cas-2025.json"]];
      const datasets = [];
      this.loadWarnings = [];
      for (const [kind, name] of files) {
        // The packaged root is jar:file: and may contain '@'. Zotero 10's HTTP
        // URL helper cannot read that URI; getResourceAsync uses a local channel.
        let builtin = null;
        try {
          const data = root.ScholarCore.validateDataset(JSON.parse(await Zotero.File.getResourceAsync(rootURI + "data/" + name)));
          if (data.kind !== kind) throw new Error("内置数据包类型不一致");
          builtin = data;
        } catch (_) {
          // A corrupt/missing bundled table may be replaced by a valid local
          // import. Otherwise surface a warning rather than guessing values.
        }
        let selected = builtin;
        const override = PathUtils.join(this.storageDir, kind + ".json");
        if (await IOUtils.exists(override)) {
          try {
            const data = root.ScholarCore.validateDataset(await IOUtils.readJSON(override));
            if (data.kind !== kind) throw new Error("数据包类型不一致");
            if (kind === "jcr" && builtin && data.metricYear < builtin.metricYear) throw new Error("本地数据早于内置指标年份");
            selected = data;
          } catch (error) {
            this.loadWarnings.push(`${kind.toUpperCase()} 自定义数据未加载：${error.message}`);
          }
        }
        if (selected) datasets.push(selected);
        else this.loadWarnings.push(`${kind.toUpperCase()} 暂无可用数据，请在设置中导入有权使用的 JSON 数据包。`);
      }
      this.catalog = new Catalog(datasets);
      this.abbreviations = new Metadata.Abbreviations();
      const abbreviationPath = PathUtils.join(this.storageDir, "abbreviations.json");
      if (await IOUtils.exists(abbreviationPath)) {
        try { this.abbreviations = new Metadata.Abbreviations(await IOUtils.readJSON(abbreviationPath)); }
        catch (error) { this.loadWarnings.push("期刊缩写表未加载：" + error.message); }
      }
      Zotero.ScholarRank10 = this;
      Zotero.ftl.addResourceIds(["zotero10-scholar.ftl"]);
      for (const win of Zotero.getMainWindows()) this.addWindow(win);
      this.registerMenus();
      this.prefID = await Zotero.PreferencePanes.register({
        id: "zotero10-scholar-settings", pluginID: id, label: "Scholar Rank", src: "prefs.xhtml", scripts: ["prefs-pane.js"],
        image: rootURI + "assets/icon.svg"
      });
      this.observer = Zotero.Notifier.registerObserver({
        notify: (event, type, ids) => {
          if (event !== "add" || type !== "item" || (!this.pref("autoNew") && !this.pref("metadata.auto")) || !this.active) return;
          this.pendingAuto = this.pendingAuto.then(async () => {
            await Zotero.Promise.delay(500);
            if (!this.active) return;
            if (!this.pref("autoNew") && !this.pref("metadata.auto")) return;
            const items = (await Zotero.Items.getAsync(ids)).filter(item => this.supported(item));
            if (!items.length) return;
            await this.apply(items, { silent: true, automatic: true, metadata: Boolean(this.pref("metadata.auto")), updateRanks: Boolean(this.pref("autoNew")) });
          }).catch(e => Zotero.logError(e));
        }
      }, ["item"], "zotero10-scholar", AUTO_NOTIFIER_PRIORITY);
    },

    pref(name) { return Zotero.Prefs.get(PREF + name, true); },
    setPref(name, value) { Zotero.Prefs.set(PREF + name, value, true); },
    window() { return Zotero.getMainWindow(); },
    addWindow(win) { if (this.active) win.MozXULElement.insertFTLIfNeeded("zotero10-scholar.ftl"); },
    removeWindow(win) { win.document.querySelector('link[href="zotero10-scholar.ftl"]')?.remove(); },

    async stop() {
      this.active = false;
      this.cancelDownload();
      this.cancelAudit();
      if (this.observer != null) Zotero.Notifier.unregisterObserver(this.observer);
      if (this.currentOperation) await this.currentOperation;
      await this.pendingAuto;
      for (const dialog of this.resultWindows) if (!dialog.closed) dialog.close();
      this.resultWindows.clear();
      this.autoResult = null;
      for (const key of this.menuIDs) Zotero.MenuManager.unregisterMenu(key);
      this.menuIDs = [];
      if (this.prefID) Zotero.PreferencePanes.unregister(this.prefID);
      for (const win of Zotero.getMainWindows()) this.removeWindow(win);
      Zotero.ftl.removeResourceIds(["zotero10-scholar.ftl"]);
      if (Zotero.ScholarRank10 === this) delete Zotero.ScholarRank10;
    },

    safeRun(task, win) {
      Promise.resolve().then(task).catch(error => {
        Zotero.logError(error);
        if (this.active && !error.scholarResultShown) this.alert("操作失败，未继续写入。\n" + error.message, win);
      });
    },
    alert(message, win = this.window()) { Services.prompt.alert(win, LABEL, message); },

    registerMenus() {
      const command = (suffix, handler) => ({
        menuType: "menuitem", l10nID: "zsr10-" + suffix,
        onShowing: (_, context) => context.setEnabled(!this.busy && context.items?.some(item => this.supported(item))),
        onCommand: (_, context) => {
          const items = [...(context.items || [])];
          const win = context.menuElem.ownerGlobal;
          this.safeRun(() => handler(items, win), win);
        }
      });
      this.menuIDs.push(Zotero.MenuManager.registerMenu({
        menuID: "scholar-items", pluginID: this.id, target: "main/library/item",
        menus: [{ menuType: "submenu", l10nID: "zsr10-menu", menus: [
          command("metadata", (items, win) => this.apply(items, { win, metadata: true, updateRanks: false })),
          command("doi", (items, win) => this.updateByDOI(items, { win })),
          command("update", (items, win) => this.apply(items, { win })),
          command("download", (items, win) => this.downloadAttachments(items, { win }))
        ] }]
      }));
      this.menuIDs.push(Zotero.MenuManager.registerMenu({
        menuID: "scholar-tools", pluginID: this.id, target: "main/menubar/tools",
        menus: [{ menuType: "menuitem", l10nID: "zsr10-settings", onCommand: () => this.safeRun(() => this.showSettings()) }]
      }));
    },

    showSettings() { Zotero.Utilities.Internal.openPreferences(this.prefID); },

    selectedItems() { return this.window()?.ZoteroPane?.getSelectedItems() || []; },
    async manageSelected(action, win = this.window()) {
      const items = this.selectedItems();
      if (!items.some(item => this.supported(item))) {
        this.alert("请先在 Zotero 主窗口中选中文献，再返回此处操作。", win); return;
      }
      if (action === "metadata") return this.apply(items, { win, metadata: true, updateRanks: false });
      if (action === "doi") return this.updateByDOI(items, { win });
      if (action === "ranks") return this.apply(items, { win });
      if (action === "download") return this.downloadAttachments(items, { win });
      throw new Error("未知的管理操作。");
    },

    rankPlan(before, { automatic = false } = {}) {
      return planUpdate(before, this.catalog.lookup(before, this.policy()), { allowOverwrite: !automatic });
    },

    supported(item) {
      return item?.isRegularItem() && ["journalArticle", "conferencePaper", "preprint"].includes(item.itemType);
    },
    editable(item) {
      return this.supported(item) && !item.deleted && !item.isFeedItem && item.library?.libraryType !== "feed" && item.isEditable();
    },
    snapshot(item) {
      const fields = [...new Set(["title", "publicationTitle", "journalAbbreviation", "ISSN", "proceedingsTitle", "conferenceName", "archiveID", "callNumber", "extra", ...Metadata.DOI_FIELDS])];
      const data = { itemType: item.itemType, key: item.key, id: item.id, libraryID: item.libraryID };
      for (const field of fields) {
        data[field] = Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), item.itemTypeID) ? String(item.getField(field) || "") : "";
      }
      data.creators = item.getCreatorsJSON();
      return data;
    },
    policy() { return ["best", "worst", "all"].includes(this.pref("quartilePolicy")) ? this.pref("quartilePolicy") : "best"; },

    metadataOptions() {
      return { ...Object.fromEntries(Object.entries(Metadata.DEFAULTS).map(([name, fallback]) => [name, this.pref("metadata." + name) ?? fallback])),
        titleCase: this.pref("metadata.titleCase") || "sentence", protectedTerms: this.pref("metadata.protectedTerms") || "" };
    },

    metadataPlan(before, { updateRanks = false, automatic = false } = {}) {
      const metadata = Metadata.plan(before, this.metadataOptions(), this.abbreviations, this.catalog);
      const fields = { ...metadata.fields }, warnings = [...metadata.warnings];
      if (updateRanks) {
        const rank = this.rankPlan({ ...before, ...fields }, { automatic });
        if (rank.action === "write") fields.callNumber = rank.callNumber;
      }
      return Object.keys(fields).length ? { action: "write", fields, warnings }
        : { action: "skip", reason: "unchanged", fields, warnings };
    },

    showResult(counts, win, changes = [], { operation = "更新分区指标", automatic = false, silent = false, outcomes = [] } = {}) {
      const report = Reports.create(operation, counts, changes, REASONS, outcomes);
      this.status = report.summary.join("；");
      if (!this.active || (silent && !automatic)) return;
      try {
        // One nonmodal window per manual batch. Automatic batches share the
        // currently open automatic result window without interrupting imports.
        if (automatic && this.autoResult && !this.autoResult.win.closed) {
          this.autoResult.data.batches.push(report);
          this.autoResult.win.dispatchEvent(new this.autoResult.win.Event("scholar-rank-results"));
          return;
        }
        const owner = win?.openDialog ? win : this.window();
        if (!owner) return;
        const data = { batches: [report], automatic };
        const dialog = owner.openDialog("chrome://zotero10-scholar/content/results.xhtml", "",
          "chrome,dialog=no,resizable,centerscreen", data);
        this.resultWindows.add(dialog);
        if (automatic) this.autoResult = { win: dialog, data };
        dialog.addEventListener("unload", event => {
          // openDialog first unloads about:blank before loading our page.
          // That event must not discard a newly opened result window.
          if (event.target?.documentURI !== "chrome://zotero10-scholar/content/results.xhtml") return;
          this.resultWindows.delete(dialog);
          if (this.autoResult?.win === dialog) this.autoResult = null;
        });
      } catch (error) {
        // Saving already committed. A display failure must not be reported as
        // a failed update or cause a second write attempt.
        Zotero.logError(error);
        this.alert("更新结果窗口未能打开。\n\n" + Reports.toText(report), win);
      }
    },

    beginOperation() {
      this.busy = true;
      let done;
      this.currentOperation = new Promise(resolve => { done = resolve; });
      return () => { this.busy = false; this.currentOperation = null; done(); };
    },

    cancelDownload() {
      if (!this.downloadTask) return;
      this.downloadTask.cancelled = true;
      this.downloadTask.xhr?.abort();
    },

    hasFullText(item) {
      return ["application/pdf", "application/epub+zip"].some(type => item.numFileAttachmentsWithContentType(type) > 0);
    },

    async attachmentRequest(url, options, task) {
      let tooLarge = false;
      const { method = "GET", ...requestOptions } = options;
      try {
        return await Zotero.HTTP.request(method, url, { ...requestOptions, requestObserver: xhr => {
          task.xhr = xhr;
          xhr.addEventListener("progress", event => {
            if (event.loaded > Attachments.MAX_BYTES || (event.lengthComputable && event.total > Attachments.MAX_BYTES)) {
              tooLarge = true; xhr.abort();
            }
          });
        } });
      } catch (error) {
        if (tooLarge) throw new Attachments.DownloadError("pdf-too-large");
        throw error;
      } finally { task.xhr = null; }
    },

    attachmentDownloader(task) {
      return new Attachments.Downloader({
        cancelled: () => !this.active || task.cancelled,
        now: () => Date.now(), delay: ms => Zotero.Promise.delay(ms),
        request: (url, options) => this.attachmentRequest(url, options, task),
        decode: bytes => new TextDecoder().decode(bytes),
        parseHTML: html => new (this.window().DOMParser)().parseFromString(html, "text/html")
      });
    },

    async storePDF(item, before, result, task) {
      let directory;
      const ensureCurrent = () => {
        if (!this.active || task.cancelled) throw new Attachments.DownloadError("pdf-cancelled", true);
        if (!this.editable(item) || item.library?.filesEditable === false) throw new Attachments.DownloadError("read-only");
        if (JSON.stringify(before) !== JSON.stringify(this.snapshot(item))) throw new Attachments.DownloadError("manually-edited");
        if (this.hasFullText(item)) throw new Attachments.DownloadError("pdf-existing");
      };
      ensureCurrent();
      try {
        directory = (await Zotero.Attachments.createTemporaryStorageDirectory()).path;
        const filename = Zotero.Attachments.getFileBaseNameFromItem(item).slice(0, 150) + ".pdf";
        await IOUtils.write(PathUtils.join(directory, filename), result.bytes);
        ensureCurrent();
        const attachment = await Zotero.Attachments.createURLAttachmentFromTemporaryStorageDirectory({
          directory, libraryID: item.libraryID, parentItemID: item.id, filename,
          title: "全文 PDF", url: result.url, contentType: "application/pdf"
        });
        return { attachment, filename };
      } finally {
        // Only the temporary directory allocated above; never an existing attachment.
        // Successful native import moves it into storage, so it no longer exists.
        if (directory && await IOUtils.exists(directory)) await IOUtils.remove(directory, { recursive: true });
      }
    },

    async downloadAttachments(items, { win = this.window(), silent = false } = {}) {
      if (!this.active) return;
      if (this.busy) { this.alert("上一批操作尚未结束，请稍后再试。", win); return; }
      const finish = this.beginOperation(), counts = {}, changes = [], outcomes = [], seen = new Set();
      const task = this.downloadTask = { cancelled: false, xhr: null };
      const downloader = this.attachmentDownloader(task);
      let halted = false;
      const outcome = (item, reason) => {
        counts[reason] = (counts[reason] || 0) + 1;
        outcomes.push({ id: item?.id, title: item?.getField("title") || "无标题", reason });
      };
      try {
        for (const item of items) {
          if (!item || seen.has(item.id)) continue;
          seen.add(item.id);
          if (halted || task.cancelled || !this.active) { outcome(item, "pdf-not-attempted"); continue; }
          if (!this.supported(item)) { outcome(item, "unsupported-type"); continue; }
          if (!this.editable(item) || item.library?.filesEditable === false) { outcome(item, "read-only"); continue; }
          if (this.hasFullText(item)) { outcome(item, "pdf-existing"); continue; }
          if (!Zotero.Attachments?.createURLAttachmentFromTemporaryStorageDirectory) { outcome(item, "pdf-unavailable"); continue; }
          const before = this.snapshot(item), DOI = Metadata.doiKey(before.DOI);
          let url = "";
          if (before.url) {
            try { url = Attachments.checkedURL(before.url); }
            catch (error) { if (!DOI) { outcome(item, error.reason); continue; } }
          }
          if (!DOI && !url) { outcome(item, "pdf-no-source"); continue; }
          this.status = `下载全文 PDF：${seen.size}/${items.length} · ${before.title}`;
          let saving = false;
          try {
            const result = await downloader.find({ DOI, url });
            saving = true;
            const { filename } = await this.storePDF(item, before, result, task);
            changes.push(Reports.changedItem({ ...before, pdf: "" }, { ...before, pdf: `${filename}\n${result.url}` }, ["pdf"]));
            outcome(item, "downloaded");
          } catch (error) {
            outcome(item, error.reason || (saving ? "pdf-save-failed" : "pdf-network-failed"));
            if (error.stopBatch) halted = true;
            Zotero.debug?.("Scholar Rank: manual PDF result " + (error.reason || "failed"));
          }
        }
        this.showResult(counts, win, changes, { operation: "下载全文 PDF", silent, outcomes });
        return counts;
      } finally { this.downloadTask = null; finish(); }
    },

    async apply(items, {
      automatic = false, silent = false, win = this.window(), metadata = false, updateRanks = !metadata
    } = {}) {
      if (!this.active) return;
      if (this.busy) {
        if (silent) {
          await this.currentOperation;
          return this.apply(items, { automatic, silent, win, metadata, updateRanks });
        }
        this.alert("上一批更新尚未结束，请稍后再试。", win);
        return;
      }
      const finish = this.beginOperation();
      const counts = {}, changes = [], seen = new Set();
      const operation = metadata ? (updateRanks ? "整理元数据及更新分区指标" : "整理元数据") : "更新分区指标";
      let committed = false;
      const count = reason => { counts[reason] = (counts[reason] || 0) + 1; };
      try {
        for (const item of items) {
          if (!item || seen.has(item.id)) continue;
          seen.add(item.id);
          if (!this.supported(item)) { count("unsupported-type"); continue; }
          if (!this.editable(item)) { count("read-only"); continue; }
          const before = this.snapshot(item);
          const plan = metadata ? this.metadataPlan(before, { updateRanks, automatic })
            : this.rankPlan(before, { automatic });
          if (plan.action === "write") changes.push({ item, before, plan });
          else count(plan.reason);
        }
        const saved = await this.saveChanges(changes, counts);
        committed = true;
        if (metadata && !automatic && this.pref("metadata.duplicates") && this.active) {
          try {
            const snapshots = [];
            for (const libraryID of new Set(items.filter(item => this.supported(item)).map(item => item.libraryID))) {
              const all = await Zotero.Items.getAll(libraryID, true, false, false);
              await Zotero.Items.loadDataTypes(all, ["itemData"]);
              for (const item of all) if (this.supported(item) && !item.deleted) snapshots.push({
                id: item.id, libraryID, title: item.getField("title"), DOI: item.getField("DOI")
              });
            }
            const selected = new Set(items.map(item => item?.id)), lookup = Metadata.duplicateIndex(snapshots);
            const duplicateCount = snapshots.filter(item => selected.has(item.id) && lookup(item).length).length;
            if (duplicateCount) counts.duplicates = duplicateCount;
          } catch (error) { Zotero.logError(error); counts["duplicate-check-failed"] = 1; }
        }
        this.showResult(counts, win, saved, { operation, automatic, silent });
        return counts;
      } catch (error) {
        if (!committed && this.active) {
          this.showResult({ "update-failed": 1 }, win, [], { operation, automatic, silent });
          error.scholarResultShown = !silent || automatic;
        }
        throw error;
      } finally { finish(); }
    },

    async saveChanges(changes, counts) {
      if (!changes.length) return [];
      const touched = [], saved = [];
      try {
        await Zotero.DB.executeTransaction(async () => {
          let written = 0;
          for (const { item, before, plan } of changes) {
            if (!this.active) throw new Error("插件已停用，已回滚本批更新。");
            const current = this.snapshot(item);
            if (!this.editable(item) || Object.keys(before).some(key => JSON.stringify(current[key]) !== JSON.stringify(before[key]))) {
              counts["manually-edited"] = (counts["manually-edited"] || 0) + 1; continue;
            }
            const fields = plan.fields || { callNumber: plan.callNumber };
            const targetType = plan.itemType ? Zotero.ItemTypes.getID(plan.itemType) : item.itemTypeID;
            if (Object.entries(fields).some(([field, value]) => typeof value !== "string" || ![...Metadata.DOI_FIELDS, "callNumber"].includes(field)
                || !Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), targetType))) {
              throw new Error("条目不支持待更新字段，已回滚本批更新。");
            }
            touched.push(item);
            if (plan.itemType) item.setType(targetType);
            for (const [field, value] of Object.entries(fields)) item.setField(field, value);
            if (plan.creators) item.setCreators(plan.creators);
            await item.save({ skipSelect: true });
            const changed = Reports.changedItem(before, this.snapshot(item), [...Object.keys(fields), ...(plan.itemType ? ["itemType"] : []), ...(plan.creators ? ["creators"] : [])]);
            if (changed) { saved.push(changed); written++; }
          }
          if (!this.active) throw new Error("插件已停用，已回滚本批更新。");
          if (written) Zotero.UndoHistory.stageAction("undo-action-edit-metadata", { count: written });
          counts.written = written;
        });
        // Only return diffs once the entire transaction has committed.
        return saved;
      } catch (error) {
        for (const item of touched) await item.reload(null, true).catch(e => Zotero.logError(e));
        throw error;
      }
    },

    async lookupDOI(doi) {
      const search = new Zotero.Translate.Search();
      // Same native search API used by Zotero's identifier lookup, but never
      // save the returned items or download attachments. Only send the DOI.
      search.setIdentifier({ DOI: doi });
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const translators = await search.getTranslators();
            if (!translators.length) throw new Error("未找到可用的 DOI 查询器。");
            search.setTranslator(translators);
            const items = await search.translate({ libraryID: false, saveAttachments: false });
            try {
              // Crossref supplies explicit ConferenceInfo/event dates that the
              // native flattened date field loses. Never send library content.
              const response = await Zotero.HTTP.request("GET", "https://api.crossref.org/works/" + encodeURIComponent(doi),
                { responseType: "json", timeout: 15000 });
              const data = response.response?.message;
              if (Metadata.doiKey(data?.DOI) === Metadata.doiKey(doi)) {
                for (const item of items) item.scholarCrossref = data;
              }
            } catch (error) { Zotero.debug?.("Scholar Rank: supplementary DOI date lookup unavailable."); }
            return items;
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DOI 查询超时。")), 45000); })
        ]);
      } finally { clearTimeout(timer); }
    },

    cancelAudit() { if (this.auditTask) this.auditTask.cancelled = true; },

    async fetchAuditJSON(kind, key, url) {
      const response = await Zotero.HTTP.request("GET", url, {responseType:kind === "publisher" ? "text" : "json", timeout:15000,
        errorDelayMax:0, noRetryOnThrottle:true});
      return response.response;
    },

    async allPaperItems() {
      const items = [];
      for (const library of Zotero.Libraries.getAll()) {
        if (!library.editable || !["user", "group"].includes(library.libraryType)) continue;
        const records = await Zotero.Items.getAll(library.libraryID, true, false);
        await Zotero.Items.loadDataTypes(records,["itemData","creators","collections","childItems"]);
        items.push(...records.filter(item => item.isRegularItem() && !item.deleted && !item.isFeedItem));
      }
      return [...new Map(items.map(item => [item.id,item])).values()];
    },

    async auditLibrary(options = {}) {
      return this.auditItems(await this.allPaperItems(), options);
    },

    async auditItems(items, {win = this.window(), silent = false, preferPublished = true, onProgress} = {}) {
      if (!this.active) return;
      if (this.busy) { this.alert("上一批处理尚未结束，请稍后再试。",win); return; }
      const finish = this.beginOperation(), task = {cancelled:false};
      this.auditTask = task;
      const client = new Publications.Client((kind,key,url) => this.fetchAuditJSON(kind,key,url), () => task.cancelled || !this.active);
      const report = {operation:"文献核对与补全", startedAt:new Date().toISOString(), counts:{checked:0,written:0,promoted:0}, items:[], outcomes:[]};
      this.lastAudit = report;
      const selected = [...new Map(items.filter(Boolean).map(item => [item.id,item])).values()];
      try {
        for (const [index,item] of selected.entries()) {
          if (task.cancelled || !this.active) break;
          this.status = `核对文献 ${index + 1}/${selected.length} · ${item.getField("title")}`;
          const outcome = {id:item.id,key:item.key,libraryID:item.libraryID,title:item.getField("title"),reason:"verified"};
          try {
            if (!["journalArticle","conferencePaper","preprint","bookSection","report","thesis"].includes(item.itemType)) {
              outcome.reason = "unsupported-type";
            } else if (!item.isEditable() || item.deleted || item.isFeedItem) {
              outcome.reason = "read-only";
            } else {
              const before = this.snapshot(item);
              outcome.missingBefore = Publications.missing(before);
              const match = await client.resolve(before,{preferPublished});
              if (task.cancelled || !this.active) break;
              outcome.reason = match.reason;
              outcome.errors = match.errors;
              if (match.source) {
                const plan = Publications.plan(before,match.source,this.metadataOptions(),this.catalog);
                const targetType = plan.itemType ? Zotero.ItemTypes.getID(plan.itemType) : item.itemTypeID;
                if (plan.creators) plan.creators = plan.creators.filter(person => Zotero.CreatorTypes.isValidForItemType(Zotero.CreatorTypes.getID(person.creatorType),targetType));
                for (const field of Object.keys(plan.fields)) {
                  if (!Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field),targetType)) delete plan.fields[field];
                }
                outcome.source = match.source.source;
                outcome.sourceURL = match.source.sourceURL;
                outcome.missingAfter = plan.missing;
                outcome.sourceMissing = plan.sourceMissing;
                outcome.dateUnverified = plan.dateUnverified;
                if (plan.action === "write") {
                  const counts = {}, saved = await this.saveChanges([{item,before,plan}],counts);
                  report.items.push(...saved);
                  report.counts.written += counts.written || 0;
                  if (saved.length && plan.promoted) report.counts.promoted++;
                  outcome.reason = saved.length ? "verified" : Object.keys(counts).find(key => key !== "written") || "unchanged";
                }
                const gaps = (outcome.sourceMissing || []).filter(field => ["publicationTitle","proceedingsTitle","volume","issue","pages"].includes(field));
                outcome.message = (REASONS[outcome.reason] || outcome.reason) + " · 来源 " + outcome.source
                  + (gaps.length ? "\n来源未提供 " + gaps.join("、") : "");
              }
            }
          } catch (error) {
            if (task.cancelled || !this.active) break;
            outcome.reason = "audit-failed";
            outcome.error = String(error.message || error);
            Zotero.logError(error);
          }
          report.counts.checked++;
          report.outcomes.push(outcome);
          if (onProgress) await onProgress(report);
          await Zotero.Promise.delay(250);
        }
        report.cancelled = task.cancelled;
        report.total = selected.length;
        report.completedAt = new Date().toISOString();
        if (task.cancelled) report.counts["audit-cancelled"] = 1;
        if (this.active) this.showResult(report.counts,win,report.items,{operation:report.operation,silent,outcomes:report.outcomes});
        if (onProgress) await onProgress(report);
        return report;
      } finally { this.auditTask = null; finish(); }
    },

    async lookupTitle(query) {
      const parameters = [["query.bibliographic",query.bibliographic],["query.author",query.author],["rows","20"]];
      const url = "https://api.crossref.org/works?" + parameters.map(([name,value])=>`${name}=${encodeURIComponent(value)}`).join("&");
      const response = await Zotero.HTTP.request("GET", url, { responseType:"json", timeout:15000 });
      const records = response.response?.message?.items;
      if (!Array.isArray(records)) throw new Error("联网检索返回格式异常。");
      return records;
    },

    async lookupConference(before) {
      const query = Search.conferenceQuery(before);
      if (!query) return [];
      const url = "https://sparql.dblp.org/sparql?query=" + encodeURIComponent(query) + "&format=json";
      const response = await Zotero.HTTP.request("GET", url, {responseType:"json",timeout:15000});
      const rows = response.response?.results?.bindings;
      if (!Array.isArray(rows)) throw new Error("会议检索返回格式异常。");
      return Search.conferenceRecords(rows);
    },

    async lookupPreprint(before) {
      const doi = Metadata.doiKey(before.DOI) || Search.arxivDOI(before);
      let url = "https://api.datacite.org/dois/";
      if (doi) url += encodeURIComponent(doi);
      else {
        const query = Search.preprintQuery(before);
        if (!query) return [];
        url += "?query=" + encodeURIComponent(query) + "&resource-type-id=preprint&sort=relevance&page%5Bsize%5D=20";
      }
      const response = await Zotero.HTTP.request("GET",url,{responseType:"json",timeout:15000});
      const data = response.response?.data;
      if (!data || (typeof data !== "object")) throw new Error("预印本检索返回格式异常。");
      return Array.isArray(data) ? data : [data];
    },

    // Keep the method name for existing callers; this is the manual online
    // command, with DOI-first lookup and an empty-DOI bibliographic fallback.
    async updateByDOI(items, { win = this.window(), silent = false } = {}) {
      if (!this.active) return;
      if (this.busy) { this.alert("上一批更新尚未结束，请稍后再试。", win); return; }
      const finish = this.beginOperation(), counts = {}, changes = [], cache = new Map(), searches = new Map();
      let committed = false;
      const selected = [...new Map(items.filter(Boolean).map(item => [item.id, item])).values()];
      const count = reason => { counts[reason] = (counts[reason] || 0) + 1; };
      try {
        for (const [index, item] of selected.entries()) {
          if (!this.active) return;
          this.status = `联网核对 ${index + 1}/${selected.length}`;
          if (!this.supported(item)) { count("unsupported-type"); continue; }
          if (!this.editable(item)) { count("read-only"); continue; }
          const before = this.snapshot(item);
          if (before.itemType === "preprint") {
            if (before.DOI.trim() && !Metadata.doiKey(before.DOI)) { count("invalid-doi"); continue; }
            if (!Metadata.doiKey(before.DOI) && !Search.arxivDOI(before) && !Search.preprintQuery(before)) {
              count("search-insufficient"); continue;
            }
            try {
              const key = "preprint:" + JSON.stringify(before);
              if (!searches.has(key)) searches.set(key,this.lookupPreprint(before));
              const records = await searches.get(key);
              if (!this.active) return;
              const plan = Search.preprintPlan(before,records,this.metadataOptions(),this.catalog);
              if (plan.action === "write") changes.push({item,before,plan});
              else count(plan.reason);
            } catch (error) { Zotero.logError(error); count("search-failed"); }
            continue;
          }
          let doi = Metadata.doiKey(before.DOI), discovered = null;
          if (!doi) {
            if (before.DOI.trim()) { count("invalid-doi"); continue; }
            const query = Search.query(before);
            if (!query) { count("search-insufficient"); continue; }
            let records;
            try {
              if (!searches.has(query.cacheKey)) searches.set(query.cacheKey, this.lookupTitle(query));
              records = await searches.get(query.cacheKey);
            } catch (error) { Zotero.logError(error); count("search-failed"); continue; }
            if (!this.active) return;
            const match = Search.select(before, records, this.catalog);
            if (!match.record) {
              if (match.reason !== "search-no-match" || !Search.conferenceQuery(before)) { count(match.reason); continue; }
              try {
                const key = "conference:" + Search.conferenceQuery(before);
                if (!searches.has(key)) searches.set(key,this.lookupConference(before));
                const records = await searches.get(key);
                if (!this.active) return;
                const plan = Search.conferencePlan(before,records,this.metadataOptions(),this.catalog);
                if (plan.action === "write") changes.push({item,before,plan});
                else count(plan.reason);
              } catch (error) { Zotero.logError(error); count("search-failed"); }
              continue;
            }
            discovered = match.record; doi = Metadata.doiKey(discovered.DOI);
          }
          let sources;
          try {
            if (!cache.has(doi)) cache.set(doi, this.lookupDOI(Metadata.cleanDOI(discovered?.DOI || before.DOI)));
            sources = await cache.get(doi);
          } catch (error) { Zotero.logError(error); count("lookup-failed"); continue; }
          if (!this.active) return;
          const matches = (Array.isArray(sources) ? sources : []).filter(source => Metadata.doiKey(source?.DOI) === doi);
          if (matches.length !== 1) { count("doi-mismatch"); continue; }
          const plan = discovered ? Search.resolvedPlan(before, discovered, matches[0], this.metadataOptions(), this.catalog)
            : Metadata.doiPlan(before, matches[0], this.metadataOptions(), this.catalog);
          if (plan.dateUnverified) count("conference-date-unverified");
          for (const field of Object.keys(plan.fields)) {
            if (!Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), item.itemTypeID)) delete plan.fields[field];
          }
          if (plan.creators?.some(creator => !Zotero.CreatorTypes.isValidForItemType(Zotero.CreatorTypes.getID(creator.creatorType), item.itemTypeID))) {
            delete plan.creators;
          }
          if (plan.action === "write" && (Object.keys(plan.fields).length || plan.creators)) changes.push({ item, before, plan });
          else count(plan.reason || "unchanged");
        }
        const saved = await this.saveChanges(changes, counts);
        committed = true;
        this.showResult(counts, win, saved, { operation: "联网更新元数据", silent });
        return counts;
      } catch (error) {
        if (!committed && this.active) {
          this.showResult({ "update-failed": 1 }, win, [], { operation: "联网更新元数据", silent });
          error.scholarResultShown = !silent;
        }
        throw error;
      } finally { finish(); }
    },

    async importAbbreviations(win = this.window()) {
      const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const fp = new FilePicker(); fp.init(win, "导入期刊缩写 JSON 表", fp.modeOpen); fp.appendFilter("JSON", "*.json");
      if (await fp.show() !== fp.returnOK || !this.active) return;
      if ((await IOUtils.stat(fp.file)).size > 20 * 1024 * 1024) throw new Error("缩写表超过 20 MB。");
      const data = await IOUtils.readJSON(fp.file), catalog = new Metadata.Abbreviations(data);
      if (!this.active || !Services.prompt.confirm(win, LABEL, `导入 ${catalog.count} 条期刊缩写？\n来源：${catalog.source}\n仅加载表，不修改文献。`)) return;
      while (this.currentOperation) await this.currentOperation;
      if (!this.active) return;
      const finish = this.beginOperation();
      try {
        await IOUtils.makeDirectory(this.storageDir, { ignoreExisting: true });
        if (!this.active) return;
        const path = PathUtils.join(this.storageDir, "abbreviations.json");
        await IOUtils.writeJSON(path, data, { tmpPath: path + ".tmp" });
        this.abbreviations = catalog;
      } finally { finish(); }
    },

    dataSummary() {
      return this.catalog.list().map(d => `${d.kind.toUpperCase()} ${d.edition}${d.kind === "jcr" ? `（IF ${d.metricYear}）` : ""}：${d.count} 条`).join("；")
        || "尚未加载指标数据。请打开 Scholar Rank 设置，导入有权使用的 JSON 数据包。";
    },

    async importDataset(win = this.window()) {
      if (!this.active) return;
      const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const fp = new FilePicker();
      fp.init(win, "导入 Scholar Rank JSON 数据包", fp.modeOpen);
      fp.appendFilter("Scholar Rank JSON", "*.json");
      if (await fp.show() !== fp.returnOK) return;
      if (!this.active) return;
      if ((await IOUtils.stat(fp.file)).size > 40 * 1024 * 1024) throw new Error("数据包超过 40 MB。");
      const data = root.ScholarCore.validateDataset(await IOUtils.readJSON(fp.file));
      if (!this.active) return;
      const current = this.catalog.indexes[data.kind]?.dataset;
      if (data.kind === "jcr" && current && data.metricYear < current.metricYear) throw new Error("不能用更早年份的 JIF 覆盖当前数据。");
      if (!Services.prompt.confirm(win, LABEL, `导入 ${data.kind.toUpperCase()} ${data.edition}，${data.records.length} 条？\n来源：${data.source}\n\n只更新数据包，文献条目需另行点击更新。数据包来源由导入者核实。`)) return;
      while (this.currentOperation) await this.currentOperation;
      if (!this.active) return;
      const finish = this.beginOperation();
      try {
        const latest = this.catalog.indexes[data.kind]?.dataset;
        if (data.kind === "jcr" && latest && data.metricYear < latest.metricYear) throw new Error("其他导入操作已加载更新年份，本次旧数据未写入。");
        await IOUtils.makeDirectory(this.storageDir, { ignoreExisting: true });
        if (!this.active) return;
        const path = PathUtils.join(this.storageDir, data.kind + ".json");
        await IOUtils.writeJSON(path, data, { tmpPath: path + ".tmp" });
        this.catalog.replace(data);
        this.loadWarnings = this.loadWarnings.filter(warning => !warning.startsWith(data.kind.toUpperCase() + " "));
        if (this.active) this.alert("数据包已加载。\n" + this.dataSummary(), win);
      } finally { finish(); }
    }
  };
  root.ScholarPlugin = plugin;
})(globalThis);
