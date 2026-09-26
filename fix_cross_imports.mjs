import fs from 'fs';

let disc = fs.readFileSync('server/worker/stage1Discovery.js', 'utf8');
if (!disc.includes("import { runStage1Pipeline }")) {
  disc = disc.replace(/import { tempDir.*?paths\.js';\r?\n/, match => match + "import { runStage1Pipeline } from './stage1Render.js';\n");
  fs.writeFileSync('server/worker/stage1Discovery.js', disc);
}

let retry = fs.readFileSync('server/worker/autoRetryService.js', 'utf8');
if (!retry.includes("import { runStage1Pipeline }")) {
  retry = retry.replace(/import { tempDir.*?paths\.js';\r?\n/, match => match + "import { runStage1Pipeline } from './stage1Render.js';\nimport { conformExistingJobEditToAudio, runProfessionalFinalQcWithRepair, syncVideoToAndroidStorage } from './finalizationService.js';\n");
  fs.writeFileSync('server/worker/autoRetryService.js', retry);
}

let render = fs.readFileSync('server/worker/stage1Render.js', 'utf8');
if (!render.includes("import { processJobVoiceover")) {
  render = render.replace(/import { tempDir.*?paths\.js';\r?\n/, match => match + "import { processJobVoiceover } from './finalizationService.js';\n");
  fs.writeFileSync('server/worker/stage1Render.js', render);
}

console.log('Cross imports injected');
