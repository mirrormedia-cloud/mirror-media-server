import fs from "node:fs";
import path from "node:path";

type Level = "info" | "error";

export class DailyLogFiles {
  private baseDir: string;
  private currentDate: string | null = null;
  private infoStream: fs.WriteStream | null = null;
  private errorStream: fs.WriteStream | null = null;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private getDateFolder(d = new Date()) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  private ensureStreams() {
    const today = this.getDateFolder(new Date());
    if (this.currentDate === today && this.infoStream && this.errorStream) return;

    this.close();

    this.currentDate = today;

    const dayDir = path.join(this.baseDir, today);
    fs.mkdirSync(dayDir, { recursive: true });

    this.infoStream = fs.createWriteStream(path.join(dayDir, "info.log"), { flags: "a" });
    this.errorStream = fs.createWriteStream(path.join(dayDir, "error.log"), { flags: "a" });
  }

  write(level: Level, line: string) {
    this.ensureStreams();

    if (level === "error") this.errorStream!.write(line + "\n");
    else this.infoStream!.write(line + "\n");
  }

  close() {
    this.infoStream?.end();
    this.errorStream?.end();
    this.infoStream = null;
    this.errorStream = null;
  }
}
