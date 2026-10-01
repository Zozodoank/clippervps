const fs = require('fs');

let jobsContent = fs.readFileSync('server/api/routes/jobsRoutes.js', 'utf8');
const jobsTarget = `        if (allUrls.length === 0) {
          throw new Error('Job manual tidak memiliki URL sumber tersimpan untuk di-retry. Kirim ulang link video aslinya.');
        }
        // Gunakan Set untuk menghindari URL duplikat`;
const jobsReplacement = `        if (allUrls.length === 0) {
          throw new Error('Job manual tidak memiliki URL sumber tersimpan untuk di-retry. Kirim ulang link video aslinya.');
        }
        // [FIX] Force explicitOnly for manual retries
        if (!job.options) job.options = {};
        job.options.explicitOnly = true;
        // Gunakan Set untuk menghindari URL duplikat`;
if (jobsContent.includes(jobsTarget)) {
  jobsContent = jobsContent.replace(jobsTarget, jobsReplacement);
  fs.writeFileSync('server/api/routes/jobsRoutes.js', jobsContent, 'utf8');
  console.log('Fixed jobsRoutes.js');
} else {
  console.log('Could not find target in jobsRoutes.js');
}
