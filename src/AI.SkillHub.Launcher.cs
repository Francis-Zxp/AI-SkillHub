using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace AISkillHub
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            try
            {
                string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
                string script = Path.Combine(exeDir, "SkillHub.UI.ps1");

                if (!File.Exists(script))
                {
                    MessageBox.Show(
                        "找不到 SkillHub.UI.ps1。\n\n请确认 AI SkillHub.exe 与 SkillHub.UI.ps1 在同一个文件夹。",
                        "AI SkillHub",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                    return;
                }

                string powershell = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.System),
                    "WindowsPowerShell",
                    "v1.0",
                    "powershell.exe");

                if (!File.Exists(powershell))
                {
                    powershell = "powershell.exe";
                }

                var startInfo = new ProcessStartInfo
                {
                    FileName = powershell,
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = exeDir
                };

                Process.Start(startInfo);
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "AI SkillHub", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
