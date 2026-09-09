import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {loadFleetConfig} from "../src/fleet-config.js";
import {parseConfig} from "../src/config.js";
import {createFleetServer} from "../src/fleet-server.js";
import {ConnectionPool} from "../src/connection-pool.js";

function fixture() {
 return {
  version:2,
  defaults:{mode:"restricted",toolGroups:["core","files","connections","transfer","tunnels"],allowPrograms:["hostname"],denyPrograms:["shutdown"]},
  servers:{
   gpu:{
    expectedHostname:"gpu-host",expectedGpu:"RTX 4090",
    serverInfo:{description:"Shared GPU inventory",memoryGb:64,usageGuidance:"Verify the data mount before writing."},
    defaultRoute:"ssh",
    routes:{
     ssh:{sshTarget:"gpu-ssh"},
     plink:{sshTarget:"u@192.0.2.10",sshFlavor:"plink",hostKey:"ssh-ed25519 PUBLIC",passwordFile:"SECRET_PATH",aliases:["old_gpu_plink"]},
     backup:{sshTarget:"u@192.0.2.11",sshFlavor:"plink",hostKey:"ssh-ed25519 OTHER"}
    }
   },
   other:{mode:"readonly",toolGroups:["core"],serverInfo:{description:"OTHER_PRIVATE_INVENTORY"},defaultRoute:"ssh",routes:{ssh:{sshTarget:"other"}}}
  }
 };
}

test("policy reload updates pinned routes, preserves invalid-config state and rejects transport changes", async () => {
 const raw=fixture();
 await withFleet(raw,async (fleet,file)=>{
  const selected=fleet.resolveServer("gpu","ssh");
  await withClient(createFleetServer(fleet,{server:"gpu",route:"ssh"}),async client=>{
   raw.servers.gpu.preferredPython="/opt/train/bin/python";
   raw.servers.gpu.allowProgramPaths=["/opt/train/bin/python"];
   await writeFile(file,JSON.stringify(raw));
   assert.equal((await invoke(client,"reload_config")).value.reloaded,true);
   assert.equal(fleet.resolveServer("gpu","ssh"),selected);
   const policy=(await invoke(client,"get_execution_policy")).value;
   assert.equal(policy.preferred_python,"/opt/train/bin/python");
   assert.equal(policy.preferred_python_allowed,true);
   assert.deepEqual(fleet.resolveServer("gpu","plink").allowProgramPaths,["/opt/train/bin/python"]);
   await writeFile(file,"{");
   assert.equal((await invoke(client,"reload_config")).result.isError,true);
   assert.equal(selected.preferredPython,"/opt/train/bin/python");
   raw.servers.gpu.routes.ssh.sshTarget="unexpected";
   raw.servers.gpu.allowProgramPaths=[];
   await writeFile(file,JSON.stringify(raw));
   assert.equal((await invoke(client,"reload_config")).result.isError,true);
   assert.equal(selected.sshTarget,"gpu-ssh");
   assert.deepEqual(selected.allowProgramPaths,["/opt/train/bin/python"]);
  });
 });
});
async function withFleet(raw,action) {
 const directory=await mkdtemp(path.join(os.tmpdir(),"registry-v2-"));
 try {
  const file=path.join(directory,"fleet.json");
  await writeFile(file,JSON.stringify(raw));
  await action(await loadFleetConfig(file),file);
 } finally {await rm(directory,{recursive:true,force:true});}
}
async function withClient(runtime,action) {
 const client=new Client({name:"registry-test",version:"1"});
 const [left,right]=InMemoryTransport.createLinkedPair();
 try {
  await runtime.server.connect(right);
  await client.connect(left);
  await action(client);
 } finally {await client.close();runtime.close();await runtime.server.close();}
}
async function invoke(client,name,args={}) {
 const result=await client.callTool({name,arguments:args});
 return {result,value:JSON.parse(result.content[0].text)};
}

test("registry CLI pins a server and rejects launcher overrides of policy/connection",()=>{
 const parsed=parseConfig(["--fleet-config","fleet.json","--server","gpu","--route","plink"]);
 assert.equal(parsed.selectedServer,"gpu");
 assert.equal(parsed.selectedRoute,"plink");
 for(const args of [
  ["--fleet-config","fleet.json","--route","plink"],
  ["--ssh-target","x","--server","gpu"],
  ["--fleet-config","fleet.json","--server","gpu","--ssh-target","elsewhere"],
  ["--fleet-config","fleet.json","--mode","unrestricted"],
  ["--fleet-config","fleet.json","--command-timeout","99"],
 ]) assert.throws(()=>parseConfig(args));
});

test("v2 routes and legacy aliases resolve to stable objects with one shared identity and policy",async()=>{
 await withFleet(fixture(),async fleet=>{
  const ssh=fleet.resolveServer("gpu");
  const plink=fleet.resolveServer("gpu","plink");
  assert.equal(ssh.name,"gpu@ssh");
  assert.equal(plink,fleet.resolveServer("old_gpu_plink"));
  assert.equal(plink,fleet.resolveServer("gpu@plink"));
  assert.notEqual(ssh,plink);
  assert.deepEqual(ssh.serverInfo,plink.serverInfo);
  assert.equal(ssh.expectedHostname,plink.expectedHostname);
  assert.equal(ssh.mode,plink.mode);
  assert.throws(()=>fleet.resolveServer("gpu","unknown"),/Unknown route/);
  assert.throws(()=>fleet.resolveServer("old_gpu_plink","ssh"),/conflicts/);
  assert.throws(()=>fleet.resolveServer("constructor"),/Unknown server/);
 });
});

test("v2 rejects aliases that shadow hosts and routes that override shared policy or inventory",async()=>{
 for(const mutation of [
  raw=>{raw.servers.gpu.routes.plink.mode="unrestricted";},
  raw=>{raw.servers.gpu.routes.plink.serverInfo={description:"override"};},
  raw=>{raw.servers.gpu.routes.plink.expectedHostname="wrong";},
  raw=>{raw.servers.gpu.routes.plink.aliases=["other"];},
  raw=>{raw.servers.gpu.routes.backup.aliases=["old_gpu_plink"];},
  raw=>{raw.servers.gpu.defaultRoute="missing";},
  raw=>{raw.servers.gpu.sshTarget="wrong-layer";},
  raw=>{delete raw.servers.gpu.routes.plink.hostKey;},
 ]) {
  const raw=fixture();mutation(raw);
  await assert.rejects(withFleet(raw,async()=>{}));
 }
});

test("Fleet lists hosts once, shows routes without secrets, and routes get_server_info explicitly",async()=>{
 await withFleet(fixture(),async fleet=>{
  await withClient(createFleetServer(fleet),async client=>{
   const {value:rows}=await invoke(client,"list_servers");
   assert.equal(rows.length,2);
   assert.equal(rows[0].name,"gpu");
   assert.equal(rows[0].routes.length,3);
   assert.equal(rows[0].routes.find(x=>x.route==="plink").capabilities.upload_download,false);
   assert.ok(!JSON.stringify(rows).includes("SECRET_PATH"));
   assert.ok(!JSON.stringify(rows).includes("ssh-ed25519 PUBLIC"));
   const {value}=await invoke(client,"get_server_info",{server:"old_gpu_plink"});
   assert.equal(value.name,"gpu");
   assert.equal(value.route,"plink");
   const bad=await invoke(client,"get_server_info",{server:"old_gpu_plink",route:"ssh"});
   assert.equal(bad.result.isError,true);
   const tools=await client.listTools();
   assert.ok(tools.tools.find(x=>x.name==="exec_argv").inputSchema.properties.route);
  });
 });
});

test("independent entry is pinned, hides fleet discovery and other-host inventory, and inherits policy",async()=>{
 await withFleet(fixture(),async fleet=>{
  const runtime=createFleetServer(fleet,{server:"gpu",route:"ssh"});
  await withClient(runtime,async client=>{
   assert.ok(!client.getInstructions().includes("OTHER_PRIVATE_INVENTORY"));
   assert.ok(client.getInstructions().includes("Verify the data mount"));
   const tools=await client.listTools();
   assert.ok(!tools.tools.some(x=>x.name==="list_servers"||x.name==="onboard_discovered_host"));
   for(const tool of tools.tools) {
    assert.ok(!tool.inputSchema.properties.server,tool.name);
    assert.ok(!tool.inputSchema.properties.route,tool.name);
   }
   const {value}=await invoke(client,"get_server_info");
   assert.equal(value.name,"gpu");assert.equal(value.route,"ssh");
   // Unknown keys may be stripped by SDK validation, but cannot change the target.
   const override=await invoke(client,"get_server_info",{server:"other",route:"plink"});
   assert.ok(override.result.isError || override.value.connection_id==="gpu@ssh");
   const direct=await runtime.server._registeredTools.get_server_info.handler({server:"other"});
   assert.equal(direct.isError,true);
   const denied=await invoke(client,"exec_argv",{program:"shutdown"});
   assert.equal(denied.result.isError,true);
  });
  await withClient(createFleetServer(fleet),async client=>{
   const denied=await invoke(client,"exec_argv",{server:"gpu",program:"shutdown"});
   assert.equal(denied.result.isError,true);
  });
 });
});

test("independent entry only exposes allowed groups; unknown scope fails before startup",async()=>{
 await withFleet(fixture(),async fleet=>{
  assert.throws(()=>createFleetServer(fleet,{server:"missing"}));
  assert.throws(()=>createFleetServer(fleet,{server:"gpu",route:"missing"}));
  await withClient(createFleetServer(fleet,{server:"other"}),async client=>{
   const tools=await client.listTools();
   assert.ok(!tools.tools.some(x=>x.name==="write_file"||x.name==="provide_connection_password"));
   const denied=await invoke(client,"exec_argv",{program:"hostname"});
   assert.equal(denied.result.isError,true);
  });
 });
});

test("credentials are isolated by route while aliases share the same route state",async()=>{
 await withFleet(fixture(),async fleet=>{
  const runtime=createFleetServer(fleet);
  try {
   const selected=fleet.resolveServer("old_gpu_plink");
   const other=fleet.resolveServer("gpu","backup");
   const handler=runtime.server._registeredTools.provide_connection_password.handler;
   const result=await handler({server:"old_gpu_plink",password:"test-only-password"});
   assert.ok(!result.isError);
   assert.equal(selected,fleet.resolveServer("gpu","plink"));
   assert.equal(other.passwordFile,undefined);
   assert.equal(fleet.resolveServer("gpu").passwordFile,undefined);
   const file=selected.passwordFile;
   assert.ok(existsSync(file));
   await runtime.server._registeredTools.clear_connection_password.handler({server:"gpu",route:"plink"});
   assert.equal(selected.passwordFile,"SECRET_PATH");
   assert.ok(!existsSync(file));
  } finally {runtime.close();await runtime.server.close();}
 });
});

test("unsupported Plink transfers/tunnels fail before connecting",async()=>{
 await withFleet(fixture(),async fleet=>{
  await withClient(createFleetServer(fleet),async client=>{
   for(const [name,args] of [
    ["upload_file",{local_path:"input.txt",remote_path:"/tmp/input.txt"}],
    ["start_socks_proxy",{}]
   ]) {
    const {result,value}=await invoke(client,name,{server:"gpu",route:"plink",...args});
    assert.equal(result.isError,true);
    assert.match(value.error,/not adapted to Plink/);
   }
  });
 });
});

test("an SSH failure attempts only the chosen route and never replays on another route",async()=>{
 const original=ConnectionPool.prototype.invoke;
 const calls=[];
 ConnectionPool.prototype.invoke=async function(){calls.push(this);throw new Error("simulated transport loss");};
 try {
  await withFleet(fixture(),async fleet=>{
   await withClient(createFleetServer(fleet),async client=>{
    const {result,value}=await invoke(client,"probe_identity",{server:"gpu"});
    assert.equal(result.isError,true);
    assert.match(value.error,/simulated transport loss/);
    assert.equal(calls.length,1);
   });
  });
 } finally {ConnectionPool.prototype.invoke=original;}
});
