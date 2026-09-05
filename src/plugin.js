(function (root) {
  "use strict";
  const { Catalog, planUpdate, planRestore } = root.ScholarCore;
  const Metadata = root.ScholarMetadata;
  const PREF = "extensions.zotero10scholar.";
  const LABEL = "Zotero 10 Scholar Rank";
  // Zotero awaits item observers in ascending priority order. Linter for
  // Zotero/Format Metadata uses 666 so it can clean fields after other add-ons.
  // Run the new-item lookup afterwards; this avoids both a race and retries.
  const AUTO_NOTIFIER_PRIORITY = 700;
  const REASONS = {
    "unsupported-type": "非期刊/会议条目", "no-data": "没有匹配的数据", "invalid-backup": "备份格式异常",
    "manually-edited": "索书号被手动修改，已保护", "existing-call-number": "已有索书号，未覆盖",
    "unchanged": "无需更新", "no-backup": "无插件备份", "read-only": "只读或订阅库",
    "manual-override": "已手动设定，请先恢复手动覆盖以解除保护",
    "data-unavailable": "原指标所需数据尚未加载，已保留旧值",
    "outdated-data": "JCR 数据早于已保存指标年份，已保留旧值"
  };

  const plugin = {
    active: false, busy: false, currentOperation: null, menuIDs: [], dialogs: new Set(), pendingAuto: Promise.resolve(),

    async start({ id, version, rootURI }) {
      Object.assign(this, { id, version, rootURI, active: true });
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
          // Public releases deliberately omit third-party tables. Imported
          // local packages below must still work without a bundled baseline.
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
            const items = (await Zotero.Items.getAsync(ids)).filter(Boolean);
            await this.apply(items, { silent: true, metadata: Boolean(this.pref("metadata.auto")), updateRanks: Boolean(this.pref("autoNew")) });
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
      if (this.observer != null) Zotero.Notifier.unregisterObserver(this.observer);
      if (this.currentOperation) await this.currentOperation;
      await this.pendingAuto;
      for (const key of this.menuIDs) Zotero.MenuManager.unregisterMenu(key);
      this.menuIDs = [];
      if (this.prefID) Zotero.PreferencePanes.unregister(this.prefID);
      for (const win of this.dialogs) if (!win.closed) win.close();
      this.dialogs.clear();
      for (const win of Zotero.getMainWindows()) this.removeWindow(win);
      Zotero.ftl.removeResourceIds(["zotero10-scholar.ftl"]);
      if (Zotero.ScholarRank10 === this) delete Zotero.ScholarRank10;
    },

    safeRun(task, win) {
      Promise.resolve().then(task).catch(error => {
        Zotero.logError(error);
        if (this.active) this.alert("操作失败，未继续写入。\n" + error.message, win);
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
          command("metadata", (items, win) => this.previewMetadata(items, { win })),
          command("manual", (items, win) => this.previewMetadata(items, { win, manual: true })),
          command("manual-restore", (items, win) => this.previewMetadata(items, { win, manualRestore: true })),
          command("metadata-restore", (items, win) => this.previewMetadata(items, { win, restore: true })),
          command("duplicates", (items, win) => this.previewMetadata(items, { win, duplicatesOnly: true })),
          command("preview", (items, win) => this.preview(items, win)),
          command("update", (items, win) => this.apply(items, { repairCleared: true, win })),
          command("overwrite", (items, win) => this.previewMetadata(items, { win, manual: true, ranksOnly: true })),
          command("restore", async (items, win) => {
            if (Services.prompt.confirm(win, LABEL, "恢复所选条目在首次由本插件更新前的索书号？\n手动修改过的索书号不会被覆盖。")) await this.apply(items, { restore: true, win });
          })
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
        this.alert("请先在 Zotero 主窗口中选中期刊论文或会议论文，再返回此处操作。", win); return;
      }
      const modes = { review: {}, ranks: { ranksOnly: true }, manual: { manual: true },
        restoreManual: { manualRestore: true }, restoreMetadata: { restore: true } };
      if (!Object.hasOwn(modes, action)) throw new Error("未知的管理操作。");
      return this.previewMetadata(items, { win, ...modes[action] });
    },

    rankPlan(before, { restore = false, ...options } = {}) {
      const manual = Metadata.readManual(before.extra);
      if (manual.corrupt) return { action: "skip", reason: "invalid-backup" };
      if (manual.state?.fields.callNumber) return { action: "skip", reason: "manual-override" };
      return restore ? planRestore(before) : planUpdate(before, this.catalog.lookup(before, this.policy()), options);
    },
    confirmManual(win, count) {
      return Services.prompt.confirm(win, LABEL, `确认覆盖 ${count} 条文献中右侧已修改的字段？\n\n本轮首次覆盖前的值会备份在 Extra 中，可通过“恢复手动覆盖”或 Zotero 撤销恢复。人工设定的字段会保留，不被自动整理或普通指标更新覆盖。未编辑的字段不变。`);
    },

    supported(item) {
      return item?.isRegularItem() && ["journalArticle", "conferencePaper"].includes(item.itemType);
    },
    editable(item) {
      return this.supported(item) && !item.deleted && !item.isFeedItem && item.library?.libraryType !== "feed" && item.isEditable();
    },
    snapshot(item) {
      const fields = [...new Set(["title", "publicationTitle", "journalAbbreviation", "ISSN", "proceedingsTitle", "conferenceName", "callNumber", "extra", ...Metadata.FIELDS])];
      const data = { itemType: item.itemType, key: item.key, id: item.id, libraryID: item.libraryID };
      for (const field of fields) {
        data[field] = Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), item.itemTypeID) ? String(item.getField(field) || "") : "";
      }
      return data;
    },
    policy() { return ["best", "worst", "all"].includes(this.pref("quartilePolicy")) ? this.pref("quartilePolicy") : "best"; },

    metadataOptions() {
      return Object.fromEntries(Object.entries(Metadata.DEFAULTS).map(([name, fallback]) => [name, this.pref("metadata." + name) ?? fallback]));
    },

    metadataPlan(before, { restore = false, updateRanks = true, repairCleared = true } = {}) {
      const metadata = restore ? Metadata.restore(before) : Metadata.plan(before, this.metadataOptions(), this.abbreviations);
      if (metadata.reason === "invalid-backup") return metadata;
      const fields = { ...metadata.fields }, warnings = [...metadata.warnings];
      let extra = metadata.action === "write" ? metadata.extra : before.extra;
      if (!restore && updateRanks) {
        const working = { ...before, ...fields, extra };
        const rank = this.rankPlan(working, { repairCleared });
        if (rank.action === "write") { fields.callNumber = rank.callNumber; extra = rank.extra; }
        else if (!["no-data", "unchanged"].includes(rank.reason)) warnings.push("指标：" + (REASONS[rank.reason] || rank.reason));
      }
      // A backup must never target a field absent from the live item type.
      for (const field of Object.keys(fields)) {
        if (field !== "callNumber" && !Metadata.FIELDS.includes(field)) throw new Error("不支持的整理字段：" + field);
      }
      return Object.keys(fields).length ? { action: "write", fields, extra, warnings }
        : { action: "skip", reason: metadata.reason || "unchanged", fields, warnings };
    },

    beginOperation() {
      this.busy = true;
      let done;
      this.currentOperation = new Promise(resolve => { done = resolve; });
      return () => { this.busy = false; this.currentOperation = null; done(); };
    },

    async apply(items, {
      allowOverwrite = false, repairCleared = false, restore = false, silent = false, win = this.window(), metadata = false, updateRanks = true
    } = {}) {
      if (!this.active) return;
      if (this.busy) {
        if (silent) {
          await this.currentOperation;
          return this.apply(items, { allowOverwrite, repairCleared, restore, silent, win, metadata, updateRanks });
        }
        this.alert("上一批更新尚未结束，请稍后再试。", win);
        return;
      }
      const finish = this.beginOperation();
      const counts = {}, changes = [], seen = new Set();
      const count = reason => { counts[reason] = (counts[reason] || 0) + 1; };
      try {
        for (const item of items) {
          if (!item || seen.has(item.id)) continue;
          seen.add(item.id);
          if (!this.supported(item)) { count("unsupported-type"); continue; }
          if (!this.editable(item)) { count("read-only"); continue; }
          const before = this.snapshot(item);
          const plan = metadata ? this.metadataPlan(before, { updateRanks, repairCleared })
            : this.rankPlan(before, { restore, allowOverwrite, repairCleared });
          if (plan.action === "write") changes.push({ item, before, plan });
          else count(plan.reason);
        }
        await this.saveChanges(changes, counts);
        if (!silent) {
          const lines = [`${restore ? "已恢复" : "已更新"} ${counts.written || 0} 条。`];
          for (const [key, value] of Object.entries(counts)) if (key !== "written") lines.push(`${REASONS[key] || key}：${value}`);
          if (counts["existing-call-number"]) lines.push("\n如需替换旧插件的结果，请使用“覆盖旧索书号（先备份）”。");
          lines.push("\n" + this.dataSummary());
          this.alert(lines.join("\n"), win);
        }
        return counts;
      } finally { finish(); }
    },

    async saveChanges(changes, counts) {
      if (!changes.length) return;
      const touched = [];
      try {
        await Zotero.DB.executeTransaction(async () => {
          let written = 0;
          for (const { item, before, plan } of changes) {
            if (!this.active) throw new Error("插件已停用，已回滚本批更新。");
            const current = this.snapshot(item);
            if (!this.editable(item) || Object.keys(before).some(key => current[key] !== before[key])) {
              counts["manually-edited"] = (counts["manually-edited"] || 0) + 1; continue;
            }
            const fields = plan.fields || { callNumber: plan.callNumber };
            if (Object.keys(fields).some(field => field !== "callNumber"
                && (!Metadata.FIELDS.includes(field) || !Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), item.itemTypeID)))) {
              throw new Error("条目不支持待整理字段，已回滚本批更新。");
            }
            touched.push(item);
            for (const [field, value] of Object.entries(fields)) item.setField(field, value);
            item.setField("extra", plan.extra);
            await item.save({ skipSelect: true });
            written++;
          }
          if (!this.active) throw new Error("插件已停用，已回滚本批更新。");
          if (written) Zotero.UndoHistory.stageAction("undo-action-edit-metadata", { count: written });
          counts.written = written;
        });
      } catch (error) {
        for (const item of touched) await item.reload(null, true).catch(e => Zotero.logError(e));
        throw error;
      }
    },

    async applyReviewed(changes) {
      if (!this.active) throw new Error("插件已停用，请重新打开预览。");
      if (this.busy) throw new Error("上一批更新尚未结束，请稍后再试。");
      const finish = this.beginOperation(), counts = {};
      try { await this.saveChanges(changes, counts); return counts; }
      finally { finish(); }
    },

    async findDuplicates(items) {
      const libraries = [...new Set(items.map(item => item.libraryID))];
      const snapshots = [];
      for (const libraryID of libraries) {
        const all = await Zotero.Items.getAll(libraryID, true, false, false);
        await Zotero.Items.loadDataTypes(all, ["itemData"]);
        for (const item of all) if (this.supported(item) && !item.deleted) snapshots.push(this.snapshot(item));
      }
      const lookup = Metadata.duplicateIndex(snapshots);
      return new Map(items.map(item => [item.id, lookup(this.snapshot(item))]));
    },

    async previewMetadata(items, { win = this.window(), restore = false, duplicatesOnly = false, manual = false, manualRestore = false, ranksOnly = false } = {}) {
      if (!this.active) return;
      const selected = [...new Map(items.filter(item => this.supported(item)).map(item => [item.id, item])).values()];
      const rows = [], changes = [];
      for (const item of selected) {
        const before = this.snapshot(item);
        const rank = ranksOnly && !manual ? this.rankPlan(before, { repairCleared: true }) : null;
        const plan = manual ? Metadata.planManual(before, {}) : manualRestore ? Metadata.restoreManual(before)
          : duplicatesOnly ? { action: "skip", fields: {}, warnings: [] }
          : rank ? { ...rank, fields: rank.action === "write" ? { callNumber: rank.callNumber } : {}, warnings: rank.reason ? [REASONS[rank.reason] || rank.reason] : [] }
          : this.metadataPlan(before, { restore });
        const writable = this.editable(item) && (manual ? plan.reason !== "invalid-backup" : plan.action === "write");
        if (writable) changes.push({ item, before, plan });
        const editableFields = (ranksOnly ? ["callNumber"] : Metadata.MANUAL_FIELDS).filter(name => Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(name), item.itemTypeID));
        const fields = manual ? editableFields.map(name => ({ name, before: before[name], after: before[name] }))
          : Object.entries(plan.fields).map(([name, value]) => ({ name, before: before[name], after: value }));
        const suggestions = {};
        if (manual && writable) {
          // Suggestions are frozen with the preview and never applied implicitly.
          // They do not clear unmatched metrics or override source-age safeguards.
          const working = { ...before, extra: "" };
          const cleaned = Metadata.plan(working, this.metadataOptions(), this.abbreviations);
          const result = this.catalog.lookup({ ...working, ...cleaned.fields }, this.policy());
          const previous = root.ScholarCore.readState(before.extra).state;
          const missingData = previous && Object.keys(previous.provenance || {}).some(kind => !result.availableKinds?.includes(kind));
          const olderData = previous?.provenance?.jcr?.metricYear > result.jcrMetricYear;
          if (!ranksOnly) Object.assign(suggestions, cleaned.fields);
          if (result.hasData && !missingData && !olderData) suggestions.callNumber = result.text;
          if (missingData || olderData) plan.warnings.push("数据缺失或年份较早，未提供指标覆盖建议；如确有依据，仍可手动输入。");
          for (const name of Object.keys(suggestions)) if (!editableFields.includes(name)) delete suggestions[name];
        }
        rows.push({ id: item.id, title: before.title, fields, writable, suggestions,
          warnings: [...plan.warnings, ...(!this.editable(item) ? ["只读条目，不能应用修改。"] : [])] });
      }
      let duplicates = new Map(), duplicateWarning = "";
      if (!restore && !manualRestore && !manual && !ranksOnly && (duplicatesOnly || this.pref("metadata.duplicates"))) {
        try { duplicates = await this.findDuplicates(selected); }
        catch (error) { Zotero.logError(error); duplicateWarning = "重复检查失败；未修改或删除任何条目。"; }
      }
      if (!this.active) return;
      for (const row of rows) row.duplicates = duplicates.get(row.id) || [];
      let applied = false;
      const dialog = win.openDialog("chrome://zotero10-scholar/content/metadata-preview.xhtml", "",
        "chrome,centerscreen,resizable,width=1050,height=720", {
          rows, restore, duplicatesOnly, duplicateWarning, manual, manualRestore, ranksOnly,
          abbreviationSummary: this.abbreviations.count ? `${this.abbreviations.count} 条缩写；来源：${this.abbreviations.source}` : "未导入缩写表，可在设置中导入 JSON。",
          apply: async (ids, edits = []) => {
            if (applied) throw new Error("本次预览已经应用，请重新打开预览。");
            const idsToApply = new Set(ids);
            let reviewed = changes.filter(change => idsToApply.has(change.item.id));
            if (manual) {
              const inputs = new Map();
              const available = new Set(reviewed.map(change => change.item.id));
              for (const edit of edits) {
                if (!available.has(edit.id) || inputs.has(edit.id)) throw new Error("手动编辑条目不一致。");
                inputs.set(edit.id, edit.fields);
              }
              reviewed = reviewed.map(change => {
                const values = inputs.get(change.item.id);
                if (!values || Object.keys(values).some(name => ranksOnly && name !== "callNumber")) throw new Error("缺少或不支持的手动编辑字段。");
                const plan = Metadata.planManual(change.before, values);
                if (plan.reason === "invalid-backup") throw new Error("备份异常，未覆盖。");
                return { ...change, plan };
              }).filter(change => change.plan.action === "write");
              if (!reviewed.length) return { written: 0, unchanged: true };
              if (!this.confirmManual(win, reviewed.length)) return { cancelled: true };
            }
            const result = await this.applyReviewed(reviewed);
            applied = true; return result;
          },
          selectDuplicates: async ids => {
            if (!this.active) return;
            await Zotero.getMainWindow().ZoteroPane.selectItems(ids);
          }
        });
      this.dialogs.add(dialog);
      const onUnload = event => {
        if (event.target?.documentURI !== "chrome://zotero10-scholar/content/metadata-preview.xhtml") return;
        this.dialogs.delete(dialog); dialog.removeEventListener("unload", onUnload);
      };
      dialog.addEventListener("unload", onUnload);
      return dialog;
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

    preview(items, win = this.window()) {
      const rows = items.filter(i => this.supported(i)).map(item => {
        const snapshot = this.snapshot(item);
        const result = this.catalog.lookup(snapshot, this.policy());
        const plan = this.rankPlan(snapshot, { repairCleared: true });
        return { ...snapshot, result, status: !this.editable(item) ? REASONS["read-only"] : plan.action === "write" ? "可更新" : REASONS[plan.reason] };
      });
      const dialog = win.openDialog("chrome://zotero10-scholar/content/preview.xhtml", "", "chrome,centerscreen,resizable,width=1050,height=650", {
        rows, summary: this.dataSummary(), policy: this.policy(), warnings: this.loadWarnings,
        datasets: this.catalog.list()
      });
      this.dialogs.add(dialog);
      const onUnload = event => {
        // openDialog first unloads its initial about:blank document. Keep the
        // window tracked until the actual preview unloads, including on disable.
        if (event.target?.documentURI !== "chrome://zotero10-scholar/content/preview.xhtml") return;
        this.dialogs.delete(dialog);
        dialog.removeEventListener("unload", onUnload);
      };
      dialog.addEventListener("unload", onUnload);
      return dialog;
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
