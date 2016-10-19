//---------------------------------------------------------------------
// Browser
//---------------------------------------------------------------------

import {Evaluation, Database} from "./runtime";
import * as join from "./join";
import * as client from "../client";
import * as parser from "./parser";
import * as builder from "./builder";
import {ActionImplementations} from "./actions";
import {BrowserSessionDatabase, BrowserEventDatabase, BrowserViewDatabase, BrowserEditorDatabase, BrowserInspectorDatabase} from "./databases/browserSession";
import {HttpDatabase} from "./databases/http";
import * as system from "./databases/system";
import * as analyzer from "./analyzer";

let evaluation;

class Responder {
  socket: any;
  lastParse: any;

  constructor(socket) {
    this.socket = socket;
  }

  send(json) {
    this.socket.onmessage({data: json});
  }

  sendErrors(errors) {
    if(!errors.length) return;
    let spans = [];
    let extraInfo = {};
    for(let error of errors) {
      error.injectSpan(spans, extraInfo);
    }
    this.send(JSON.stringify({type: "comments", spans, extraInfo}))
    return true;
  }

  handleEvent(json) {
    let data = JSON.parse(json);
    if(data.type === "event") {
      if(!evaluation) return;
      console.info("EVENT", json);
      let scopes = ["event"];
      let actions = [];
      for(let insert of data.insert) {
        actions.push(new ActionImplementations["+="](insert[0], insert[1], insert[2], "event", scopes));
      }
      evaluation.executeActions(actions);
    } else if(data.type === "close") {
      if(!evaluation) return;
      evaluation.close();
      evaluation = undefined;
    } else if(data.type === "parse") {
      join.nextId(0);
      let {results, errors} = parser.parseDoc(data.code || "", "editor");
      let {text, spans, extraInfo} = results;
      let {blocks, errors: buildErrors} = builder.buildDoc(results);
      // analyzer.analyze(results.blocks, spans, extraInfo);
      if(errors && errors.length) console.error(errors);
      this.lastParse = results;
      for(let error of buildErrors) {
        error.injectSpan(spans, extraInfo);
      }
      this.send(JSON.stringify({type: "parse", generation: data.generation, text, spans, extraInfo}));
    } else if(data.type === "eval") {
      if(evaluation !== undefined && data.persist) {
        let changes = evaluation.createChanges();
        let session = evaluation.getDatabase("session");
        join.nextId(0);
        for(let block of session.blocks) {
          if(block.bindActions.length) {
            block.updateBinds({positions: {}, info: []}, changes);
          }
        }
        let {blocks, errors} = builder.buildDoc(this.lastParse);
        this.sendErrors(errors);
        for(let block of blocks) {
          if(block.singleRun) block.dormant = true;
        }
        session.blocks = blocks;
        evaluation.unregisterDatabase("session");
        evaluation.registerDatabase("session", session);
        changes.commit();
        evaluation.fixpoint(changes);
      } else {
        if(evaluation) evaluation.close();
        join.nextId(0);
        let {blocks, errors} = builder.buildDoc(this.lastParse);
        this.sendErrors(errors);
        // analyzer.analyze(results.blocks);
        let browser = new BrowserSessionDatabase(responder);
        let event = new BrowserEventDatabase();
        let view = new BrowserViewDatabase();
        let editor = new BrowserEditorDatabase();
        let inspector = new BrowserInspectorDatabase();
        let session = new Database();
        session.blocks = blocks;
        evaluation = new Evaluation();
        evaluation.registerDatabase("session", session);
        evaluation.registerDatabase("browser", browser);
        evaluation.registerDatabase("event", event);

        evaluation.registerDatabase("view", view);
        evaluation.registerDatabase("editor", editor);
        evaluation.registerDatabase("inspector", inspector);

        evaluation.registerDatabase("system", system.instance);
        evaluation.registerDatabase("http", new HttpDatabase());
        evaluation.fixpoint();

        client.socket.onopen();
      }
    } else if(data.type === "tokenInfo") {
      let spans = [];
      let extraInfo = {};
      analyzer.tokenInfo(evaluation, data.tokenId, spans, extraInfo)
      this.send(JSON.stringify({type: "comments", spans, extraInfo}))

    } else if(data.type === "findNode") {
      let {record, attribute, value} = data;
      if(!record) console.error("Unable to find node for completely free EAV");

      // @NOTE: This may not be sufficient in the future.
      let db:Database = evaluation.getDatabase("browser");
      let level = db.index.lookup(record, attribute, value);
      if(!attribute && level) {
        let key = Object.keys(level.index).shift();
        level = level.lookup(key);
      }
      if(!value && level) {
        let key = Object.keys(level.index).shift();
        level = level.lookup(key);
      }

      let nodes;
      if(level) {
        nodes = Object.keys(level.index);
      } else {
        nodes = [];
      }
      this.send(JSON.stringify({type: "findNode", record, attribute, value, nodes}));
    }

  }
}

export var responder: Responder;

export function init(code) {
  responder = new Responder(client.socket);

  global["browser"] = true;
  let {results, errors} = parser.parseDoc(code || "", "editor");
  if(errors && errors.length) console.error(errors);
  responder.lastParse = results;
  let {text, spans, extraInfo} = results;
  responder.send(JSON.stringify({type: "parse", text, spans, extraInfo}));
  let {blocks, errors: buildErrors} = builder.buildDoc(results);
  console.log("BLOCKS", blocks);
  responder.sendErrors(buildErrors);
  // analyzer.analyze(results.blocks, spans, extraInfo);
  let browser = new BrowserSessionDatabase(responder);
  let event = new BrowserEventDatabase();
  let view = new BrowserViewDatabase();
  let editor = new BrowserEditorDatabase();
  let inspector = new BrowserInspectorDatabase();
  let session = new Database();
  session.blocks = blocks;
  evaluation = new Evaluation();
  evaluation.registerDatabase("session", session);
  evaluation.registerDatabase("browser", browser);
  evaluation.registerDatabase("event", event);

  evaluation.registerDatabase("view", view);
  evaluation.registerDatabase("editor", editor);
  evaluation.registerDatabase("inspector", inspector);

  evaluation.registerDatabase("system", system.instance);
  evaluation.registerDatabase("http", new HttpDatabase());
  evaluation.fixpoint();

  client.socket.onopen();
}
