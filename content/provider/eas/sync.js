"use strict";

var sync = {

    // SYNC QUEUE MANAGEMENT
    
    syncQueue : [],
    currentProzess : {},

    addAccountToSyncQueue: function (job, account = "") {
        if (account == "") {
            //Add all connected accounts to the queue - at this point we do not know anything about folders, they are handled by the sync process
            let accounts = tbSync.db.getAccounts().IDs;
            for (let i=0; i<accounts.length; i++) {
                sync.syncQueue.push( job + "." + accounts[i] );
            }
        } else {
            //Add specified account to the queue
            sync.syncQueue.push( job + "." + account );
        }

        //after jobs have been aded to the queue, try to start working on the queue
        if (sync.currentProzess.state == "idle") sync.workSyncQueue();
    },
    
    workSyncQueue: function () {
        //workSyncQueue assumes, that it is allowed to start a new sync job
        //if no more jobs in queue, do nothing
        if (sync.syncQueue.length == 0) return;

        let observerService = Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService);

        let syncrequest = sync.syncQueue.shift().split(".");
        let job = syncrequest[0];
        let account = syncrequest[1];

        switch (job) {
            case "sync":
            case "resync":
                sync.init(job, account);
                break;
            default:
                tbSync.dump("workSyncQueue()", "Unknow job for sync queue ("+ job + ")");
        }
    },

    resetSync: function () {
        //set state to idle
        sync.setSyncState("idle"); 
        //flush the queue
        sync.syncQueue = [];

        //check each account, if state is "connecting" and disconnect it
        let accounts = db.getAccounts();
        for (let i=0; i<accounts.IDs.length; i++) {
            if (accounts.data[accounts.IDs[i]].state == "connecting") this.disconnectAccount(accounts.IDs[i]);
        }

        for (let i=0; i<accounts.IDs.length; i++) {
            if (accounts.data[accounts.IDs[i]].status == "syncing") tbSync.db.setAccountSetting(accounts.IDs[i], "status", "notsyncronized");
        }

        // set each folder with PENDING status to ABORTED
        let folders = tbSync.db.findFoldersWithSetting("status", "pending");
        for (let i=0; i < folders.length; i++) {
            tbSync.db.setFolderSetting(folders[i].account, folders[i].folderID, "status", "aborted");
        }

    },

    init: function (job, account,  folderID = "") {

        //set syncdata for this sync process
        let syncdata = {};
        syncdata.account = account;
        syncdata.folderID = folderID;
        syncdata.fResync = false;
        syncdata.status = "OK";

        // set status to syncing (so settingswindow will display syncstates instead of status) and set initial syncstate
        tbSync.db.setAccountSetting(syncdata.account, "status", "syncing");
        sync.setSyncState("syncing", syncdata);

        // check if connected
        if (tbSync.db.getAccountSetting(account, "state") == "disconnected") { //allow connected and connecting
            this.finishSync(syncdata, "notconnected");
            return;
        }

        // check if connection has data
        let connection = tbSync.getConnection(account);
        if (connection.server == "" || connection.user == "") {
            this.finishSync(syncdata, "nouserhost");
            return;
        }

        switch (job) {
            case "resync":
                syncdata.fResync = true;
                tbSync.db.setAccountSetting(account, "policykey", "");

                //if folderID present, resync only that one folder, otherwise all folders
                if (folderID !== "") {
                    tbSync.db.setFolderSetting(account, folderID, "synckey", "");
                } else {
                    tbSync.db.setAccountSetting(account, "foldersynckey", "");
                    tbSync.db.setFolderSetting(account, "", "synckey", "");
                }
                
            case "sync":
                if (tbSync.db.getAccountSetting(account, "provision") == "1" && tbSync.db.getAccountSetting(account, "policykey") == "") {
                    this.getPolicykey(syncdata);
                } else {
                    this.getFolderIds(syncdata);
                }
                break;
        }
    },

    connectAccount: function (account) {
        db.setAccountSetting(account, "state", "connecting");
        db.setAccountSetting(account, "policykey", "");
        db.setAccountSetting(account, "foldersynckey", "");
    },

    disconnectAccount: function (account) {
        db.setAccountSetting(account, "state", "disconnected"); //connected, connecting or disconnected
        db.setAccountSetting(account, "policykey", "");
        db.setAccountSetting(account, "foldersynckey", "");

        //Delete all targets
        let folders = db.findFoldersWithSetting("selected", "1", account);
        for (let i = 0; i<folders.length; i++) {
            tbSync.removeTarget(folders[i].target, folders[i].type);
        }
        db.deleteAllFolders(account);

        db.setAccountSetting(account, "status", "notconnected");
    },









    // GLOBAL SYNC FUNCTIONS

    getPolicykey: function(syncdata) {
        sync.setSyncState("requestingprovision", syncdata); 

        //request provision
        let wbxml = wbxmltools.createWBXML();
        wbxml.switchpage("Provision");
        wbxml.otag("Provision");
            wbxml.otag("Policies");
                wbxml.otag("Policy");
                    wbxml.atag("PolicyType",(tbSync.db.getAccountSetting(syncdata.account, "asversion") == "2.5") ? "MS-WAP-Provisioning-XML" : "MS-EAS-Provisioning-WBXML" );
                wbxml.ctag();
            wbxml.ctag();
        wbxml.ctag();

        syncdata.next = 1;
        wbxml = this.Send(wbxml.getBytes(), this.getPolicykeyCallback.bind(this), "Provision", syncdata);
    },
    
    getPolicykeyCallback: function (responseWbxml, syncdata) {
        let policykey = wbxmltools.FindPolicykey(responseWbxml);
        tbSync.dump("policykeyCallback("+syncdata.next+")", policykey);
        tbSync.db.setAccountSetting(syncdata.account, "policykey", policykey);

        //next == 1 and 2 = resend - next ==3 = GetFolderIds() - 
        // - the protocol requests us to first send zero as policykey and get a temp policykey in return,
        // - the we need to resend this tempkey and get the final one 
        // - then we need to resend the final one and check, if we get that one back - THIS CHECK IS MISSING (TODO)
        if (syncdata.next < 3) {

            //re-request provision
            let wbxml = wbxmltools.createWBXML();
            wbxml.switchpage("Provision");
            wbxml.otag("Provision");
                wbxml.otag("Policies");
                    wbxml.otag("Policy");
                        wbxml.atag("PolicyType",(tbSync.db.getAccountSetting(syncdata.account, "asversion") == "2.5") ? "MS-WAP-Provisioning-XML" : "MS-EAS-Provisioning-WBXML" );
                        wbxml.atag("PolicyKey", policykey);
                        wbxml.atag("Status", "1");
                    wbxml.ctag();
                wbxml.ctag();
            wbxml.ctag();

            syncdata.next++;
            this.Send(wbxml.getBytes(), this.getPolicykeyCallback.bind(this), "Provision", syncdata);
        } else {
            let policykey = wbxmltools.FindPolicykey(responseWbxml);
            tbSync.dump("final returned policykey", policykey);
            this.getFolderIds(syncdata);
        }
    },

    getFolderIds: function(syncdata) {
        //if syncdata already contains a folderID, it is a specific folder sync - otherwise we scan all folders and sync all folders
        if (syncdata.folderID != "") {
            tbSync.db.setFolderSetting(syncdata.account, syncdata.folderID, "status", "pending");
            this.syncNextFolder(syncdata);
        } else {
            sync.setSyncState("requestingfolders", syncdata); 
            let foldersynckey = tbSync.db.getAccountSetting(syncdata.account, "foldersynckey");
            if (foldersynckey == "") foldersynckey = "0";

            //request foldersync
            let wbxml = wbxmltools.createWBXML();
            wbxml.switchpage("FolderHierarchy");
            wbxml.otag("FolderSync");
                wbxml.atag("SyncKey",foldersynckey);
            wbxml.ctag();

            this.Send(wbxml.getBytes(), this.getFolderIdsCallback.bind(this), "FolderSync", syncdata);
        }
    },

    getFolderIdsCallback: function (wbxml, syncdata) {

        let wbxmlData = tbSync.wbxmltools.createWBXML(wbxml).getData();
        if (this.statusIsBad(wbxmlData.FolderSync.Status, syncdata)) {
            return;
        }

        if (wbxmlData.FolderSync.SyncKey) tbSync.db.setAccountSetting(syncdata.account, "foldersynckey", wbxmlData.FolderSync.SyncKey);
        else this.finishSync(syncdata, "missingfoldersynckey");

        if (wbxmlData.FolderSync.Changes) {
            //looking for additions
            let add = xmltools.nodeAsArray(wbxmlData.FolderSync.Changes.Add);
            for (let count = 0; count < add.length; count++) {
                //check if we have a folder with that folderID (=data[ServerId])
                if (tbSync.db.getFolder(syncdata.account, add[count].ServerId) === null) {
                    //add folder
                    let newData ={};
                    newData.account = syncdata.account;
                    newData.folderID = add[count].ServerId;
                    newData.name = add[count].DisplayName;
                    newData.type = add[count].Type;
                    newData.synckey = "";
                    newData.target = "";
                    newData.selected = (newData.type == "9" || newData.type == "8" ) ? "1" : "0";
                    newData.status = "";
                    newData.lastsynctime = "";
                    tbSync.db.addFolder(newData);
                } else {
                    //TODO? - cannot add an existing folder - resync!
                }
            }
            
            //looking for updates if a folder gets moved to trash, its parentId is no longer zero! TODO
            let update = xmltools.nodeAsArray(wbxmlData.FolderSync.Changes.Update);
            for (let count = 0; count < update.length; count++) {
                //get a copy of the folder, so we can update it
                let folder = tbSync.db.getFolder(syncdata.account, update[count]["ServerId"], true);
                if (folder !== null) {
                    //update folder
                    folder.name = update[count]["DisplayName"];
                    folder.type = update[count]["Type"];
                    tbSync.db.setFolder(folder);
                } else {
                    //TODO? - cannot update an non-existing folder - resync!
                }
            }

            //looking for deletes
            let del = xmltools.nodeAsArray(wbxmlData.FolderSync.Changes.Delete);
            for (let count = 0; count < del.length; count++) {

                //get a copy of the folder, so we can del it
                let folder = tbSync.db.getFolder(syncdata.account, del[count]["ServerId"]);
                if (folder !== null) {
                    //del folder - we do not touch target (?)
                    tbSync.db.deleteFolder(syncdata.account, del[count]["ServerId"]);
                } else {
                    //TODO? - cannot del an non-existing folder - resync!
                }
            }
        }
        
        //set selected folders to pending, so they get synced
        let folders = tbSync.db.getFolders(syncdata.account);
        for (let f in folders) {
            if (folders[f].selected == "1") {
                tbSync.db.setFolderSetting(folders[f].account, folders[f].folderID, "status", "pending");
            }
        }

        this.syncNextFolder(syncdata);
    },


    //Process all folders with PENDING status
    syncNextFolder: function (syncdata) {
        let folders = tbSync.db.findFoldersWithSetting("status", "pending", syncdata.account);
        if (folders.length == 0 || syncdata.status != "OK") {
            //all folders of this account have been synced
            sync.finishAccountSync(syncdata);
        } else {
            syncdata.synckey = folders[0].synckey;
            syncdata.folderID = folders[0].folderID;
            switch (folders[0].type) {
                case "9": 
                case "14": 
                    syncdata.type = "Contacts";
                    break;
                case "8":
                case "13":
                    syncdata.type = "Calendar";
                    break;
                default:
                    sync.finishSync(syncdata, "skipped");
                    return;
            };

            if (syncdata.synckey == "") {
                //request a new syncKey
                let wbxml = tbSync.wbxmltools.createWBXML();
                wbxml.otag("Sync");
                    wbxml.otag("Collections");
                        wbxml.otag("Collection");
                            if (tbSync.db.getAccountSetting(syncdata.account, "asversion") == "2.5") wbxml.atag("Class", syncdata.type);
                            wbxml.atag("SyncKey","0");
                            wbxml.atag("CollectionId",syncdata.folderID);
                        wbxml.ctag();
                    wbxml.ctag();
                wbxml.ctag();
                this.Send(wbxml.getBytes(), this.getSynckey.bind(this), "Sync", syncdata);
            } else {
                this.startSync(syncdata); 
            }
        }
    },


    getSynckey: function (responseWbxml, syncdata) {
        syncdata.synckey = wbxmltools.FindKey(responseWbxml);
        tbSync.db.setFolderSetting(syncdata.account, syncdata.folderID, "synckey", syncdata.synckey);
        this.startSync(syncdata); 
    },


    startSync: function (syncdata) {
        switch (syncdata.type) {
            case "Contacts": 
                contactsync.fromzpush(syncdata);
                break;
            case "Calendar":
                calendarsync.start(syncdata);
                break;
        }
    },


    finishSync: function (syncdata, error = "") {
        //a folder has been finished, process next one
        let time = Date.now();
        let status = "OK";
        if (error !== "") {
            tbSync.dump("finishSync(): Error @ Account #" + syncdata.account, tbSync.getLocalizedMessage("status." + error));
            syncdata.status = error; //store latest error
            status = error;
            time = "";
        }

        if (syncdata.folderID) {
            tbSync.db.setFolderSetting(syncdata.account, syncdata.folderID, "status", status);
            tbSync.db.setFolderSetting(syncdata.account, syncdata.folderID, "lastsynctime", time);
        }

        sync.setSyncState("done", syncdata);
        this.syncNextFolder(syncdata);
    },

    
    finishAccountSync: function (syncdata) {
        let state = tbSync.db.getAccountSetting(syncdata.account, "state");
        
        if (state == "connecting") {
            if (syncdata.status == "OK") {
                tbSync.db.setAccountSetting(syncdata.account, "state", "connected");
            } else {
                this.disconnectAccount(syncdata.account);
                tbSync.db.setAccountSetting(syncdata.account, "state", "disconnected");
            }
        }
        
        if (syncdata.status != "OK") {
            // set each folder with PENDING status to ABORTED
            let folders = tbSync.db.findFoldersWithSetting("status", "pending", syncdata.account);
            for (let i=0; i < folders.length; i++) {
                tbSync.db.setFolderSetting(syncdata.account, folders[i].folderID, "status", "aborted");
            }
        }

        //update account status
        tbSync.db.setAccountSetting(syncdata.account, "lastsynctime", Date.now());
        tbSync.db.setAccountSetting(syncdata.account, "status", syncdata.status);
        sync.setSyncState("accountdone", syncdata); 
                
        //work on the queue
        if (sync.syncQueue.length > 0) sync.workSyncQueue();
        else sync.setSyncState("idle"); 
    },


    setSyncState: function(state, syncdata = null) {
        //set new state
        sync.currentProzess.state = state;
        if (syncdata !== null) {
            sync.currentProzess.account = syncdata.account;
            sync.currentProzess.folderID = syncdata.folderID;
        } else {
            sync.currentProzess.account = "";
            sync.currentProzess.folderID = "";
        }

        let observerService = Components.classes["@mozilla.org/observer-service;1"].getService(Components.interfaces.nsIObserverService);
        observerService.notifyObservers(null, "tbsync.changedSyncstate", "");
    },

    statusIsBad : function (status, syncdata) {
        switch (status) {
            case "1":
                //all fine, not bad
                return false;
            case "3": 
                tbSync.dump("wbxml status", "Server reports <invalid synchronization key> (" + status + "), resyncing.");
                sync.init("resync", syncdata.account, syncdata.folderID);
                break;
            case "12": 
                tbSync.dump("wbxml status", "Server reports <folder hierarchy changed> (" + status + "), resyncing");
                sync.init("resync", syncdata.account, syncdata.folderID);
                break;
            default:
                tbSync.dump("wbxml status", "Server reports status <"+status+">. Error? Aborting Sync.");
                sync.finishSync(syncdata, "wbxmlerror::" + status);
                break;
        }        
        return true;
    },

    Send: function (wbxml, callback, command, syncdata) {
        let platformVer = Components.classes["@mozilla.org/xre/app-info;1"].getService(Components.interfaces.nsIXULAppInfo).platformVersion;   
        
        if (tbSync.db.prefSettings.getBoolPref("debugwbxml")) tbSync.debuglog(wbxml, "["+sync.currentProzess.state+"] sending:");

        let connection = tbSync.getConnection(syncdata.account);
        let password = tbSync.getPassword(connection);

        let deviceType = 'Thunderbird';
        let deviceId = tbSync.db.getAccountSetting(syncdata.account, "deviceId");
        
        // Create request handler
        let req = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Components.interfaces.nsIXMLHttpRequest);
        req.mozBackgroundRequest = true;
        if (tbSync.db.prefSettings.getBoolPref("debugwbxml")) {
            tbSync.dump("sending", "POST " + connection.url + '?Cmd=' + command + '&User=' + connection.user + '&DeviceType=' +deviceType + '&DeviceId=' + deviceId, true);
        }
        req.open("POST", connection.url + '?Cmd=' + command + '&User=' + connection.user + '&DeviceType=' +deviceType + '&DeviceId=' + deviceId, true);
        req.overrideMimeType("text/plain");
        req.setRequestHeader("User-Agent", deviceType + ' ActiveSync');
        req.setRequestHeader("Content-Type", "application/vnd.ms-sync.wbxml");
        req.setRequestHeader("Authorization", 'Basic ' + btoa(connection.user + ':' + password));
        if (tbSync.db.getAccountSetting(syncdata.account, "asversion") == "2.5") {
            req.setRequestHeader("MS-ASProtocolVersion", "2.5");
        } else {
            req.setRequestHeader("MS-ASProtocolVersion", "14.0");
        }
        req.setRequestHeader("Content-Length", wbxml.length);
        if (tbSync.db.getAccountSetting(syncdata.account, "provision") == "1") {
            req.setRequestHeader("X-MS-PolicyKey", tbSync.db.getAccountSetting(syncdata.account, "policykey"));
        }

        req.timeout = 10000;

        req.ontimeout = function () {
            this.finishSync(syncdata, "timeout");
        }.bind(this);
        
        req.onerror = function () {
            this.finishSync(syncdata, "networkerror");
        }.bind(this);

        // Define response handler for our request
        req.onload = function() { 
            switch(req.status) {

                case 200: //OK
                    wbxml = req.responseText;
                    if (tbSync.db.prefSettings.getBoolPref("debugwbxml")) tbSync.debuglog(wbxml,"receiving");

                    //What to do on error? IS this an error? TODO
                    if (wbxml.substr(0, 4) !== String.fromCharCode(0x03, 0x01, 0x6A, 0x00)) {
                        if (wbxml.length !== 0) {
                            tbSync.dump("recieved", "expecting wbxml but got - " + req.responseText + ", request status = " + req.status + ", ready state = " + req.readyState);
                        }
                    }
                    callback(req.responseText, syncdata);
                    break;

                case 401: // AuthError
                    this.finishSync(syncdata, req.status);
                    break;

                case 449: // Request for new provision
                    if (tbSync.db.getAccountSetting(syncdata.account, "provision") == "1") {
                        sync.init("resync", syncdata.account, syncdata.folderID);
                    } else {
                        this.finishSync(syncdata, req.status);
                    }
                    break;

                case 451: // Redirect - update host and login manager 
                    let header = req.getResponseHeader("X-MS-Location");
                    let newHost = header.slice(header.indexOf("://") + 3, header.indexOf("/M"));
                    let connection = tbSync.getConnection(syncdata.account);
                    let password = tbSync.getPassword(connection);

                    tbSync.dump("redirect (451)", "header: " + header + ", oldHost: " + connection.host + ", newHost: " + newHost);

                    //If the current connection has a LoginInfo (password stored !== null), try to update it
                    if (password !== null) {
                        tbSync.dump("redirect (451)", "updating loginInfo");
                        let myLoginManager = Components.classes["@mozilla.org/login-manager;1"].getService(Components.interfaces.nsILoginManager);
                        let nsLoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Components.interfaces.nsILoginInfo, "init");
                        
                        //remove current login info
                        let currentLoginInfo = new nsLoginInfo(connection.host, connection.url, null, connection.user, password, "USER", "PASSWORD");
                        myLoginManager.removeLogin(currentLoginInfo);

                        //update host and add new login info
                        connection.host = newHost;
                        let newLoginInfo = new nsLoginInfo(connection.host, connection.url, null, connection.user, password, "USER", "PASSWORD");
                        try {
                            myLoginManager.addLogin(newLoginInfo);
                        } catch (e) {
                            this.finishSync(syncdata, "httperror::" + req.status);
                        }
                    } else {
                        //just update host
                        connection.host = newHost;
                    }

                    //TODO: We could end up in a redirect loop - stop here and ask user to manually resync?
                    sync.init("resync", syncdata.account); //resync everything
                    break;
                    
                default:
                    this.finishSync(syncdata, "httperror::" + req.status);
            }
        }.bind(this);

        try {
            if (platformVer >= 50) {
                /*nBytes = wbxml.length;
                ui8Data = new Uint8Array(nBytes);
                for (let nIdx = 0; nIdx < nBytes; nIdx++) {
                    ui8Data[nIdx] = wbxml.charCodeAt(nIdx) & 0xff;
                }*/

                req.send(wbxml);
            } else {
                let nBytes = wbxml.length;
                let ui8Data = new Uint8Array(nBytes);
                for (let nIdx = 0; nIdx < nBytes; nIdx++) {
                    ui8Data[nIdx] = wbxml.charCodeAt(nIdx) & 0xff;
                }
                //tbSync.dump("ui8Data",wbxmltools.convert2xml(wbxml))
                req.send(ui8Data);
            }
        } catch (e) {
            tbSync.dump("unknown error", e);
        }

        return true;
    }
};
