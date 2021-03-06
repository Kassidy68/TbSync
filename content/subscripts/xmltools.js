"use strict";

var xmltools = {

    nodeAsArray : function (node) {
        let a = [];
        if (node) {
            //return, if already an array
            if (node instanceof Array) return node;

            //else push node into an array
            a.push(node);
        }
        return a;
    },


    //print content of xml data object (if debug output enabled)
    printXmlData : function (data, lvl = 0) {
        if (tbSync.db.prefSettings.getBoolPref("debugdata")) {
            for (let d in data) {
                if (typeof(data[d]) == "object") {
                    tbSync.dump("DATA", " ".repeat(lvl) + d + " => ");
                    this.printXmlData(data[d], lvl+1);                
                    tbSync.dump("DATA", " ".repeat(lvl) + d + " <= ");
                } else {
                    tbSync.dump("DATA"," ".repeat(lvl) + d + " = [" + data[d] + "]");
                }
            }
        }
    },

    getDataFromXMLString: function (str) {
        let data = null;
        let oParser = Components.classes["@mozilla.org/xmlextras/domparser;1"].createInstance(Components.interfaces.nsIDOMParser);
        try {
            data = this.getDataFromXML(oParser.parseFromString(str, "text/xml"));
        } catch (e) {}
        return data;
    },

    //create data object from XML node
    getDataFromXML : function (nodes) {
        
        /*
         * The passed nodes value could be an entire document in a single node (type 9) or a 
         * single element node (type 1) as returned by getElementById. It could however also 
         * be an array of nodes as returned by getElementsByTagName or a nodeList as returned
         * by childNodes. In that case node.length is defined.
         */        
        
        // create the return object
        let obj = {};
        let nodeList = [];
        let multiplicity = {};
        
        if (nodes.length === undefined) nodeList.push(nodes);
        else nodeList = nodes;
        
        // nodelist contains all childs, if two childs have the same name, we cannot add the chils as an object, but as an array of objects
        for (let node of nodeList) { 
            if (node.nodeType == 1 || node.nodeType == 3) {
                if (!multiplicity.hasOwnProperty(node.nodeName)) multiplicity[node.nodeName] = 0;
                multiplicity[node.nodeName]++;
                //if this nodeName has multiplicity > 1, prepare obj  (but only once)
                if (multiplicity[node.nodeName]==2) obj[node.nodeName] = [];
            }
        }

        // process nodes
        for (let node of nodeList) { 
            switch (node.nodeType) {
                case 9: 
                    //document node, dive directly and process all children
                    if (node.hasChildNodes) obj = this.getDataFromXML(node.childNodes);
                    break;
                case 1: 
                    //element node
                    if (node.hasChildNodes) {
                        //if this is an element with only one text child, do not dive, but get text childs value
                        let o;
                        if (node.childNodes.length == 1 && node.childNodes.item(0).nodeType==3) {
                            o = node.childNodes.item(0).nodeValue;
                        } else {
                            o = this.getDataFromXML(node.childNodes);
                        }
                        //check, if we can add the object directly, or if we have to push it into an array
                        if (multiplicity[node.nodeName]>1) obj[node.nodeName].push(o)
                        else obj[node.nodeName] = o; 
                    }
                    break;
            }
        }
        return obj;
    }
    
};
