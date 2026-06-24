import re
import xml.etree.ElementTree as ET
import os

log_dir = os.environ.get("DEVICEFARM_LOG_DIR", "/tmp")
results_file = os.path.join(log_dir, "test-results.txt")
output_file = os.path.join(log_dir, "junitReport.xml")

suite = ET.Element("testsuite", name="qvac-mobile")
passed = 0
failed = 0

if os.path.exists(results_file):
    with open(results_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            parts = line.split("|", 1)
            if len(parts) != 2:
                continue

            status, log_line = parts

            if status == "PASS":
                m = re.search(r"\u2705\s+(.+?)\s+\((\d+)ms\)", log_line)
                if m:
                    name = m.group(1)
                    time_s = str(int(m.group(2)) / 1000.0)
                    ET.SubElement(suite, "testcase", name=name, classname="qvac", time=time_s)
                    passed += 1

            elif status == "FAIL":
                m = re.search(r"\u274c\s+(.+?)\s+\((\d+)ms\)", log_line)
                if m:
                    name = m.group(1)
                    time_s = str(int(m.group(2)) / 1000.0)
                    tc = ET.SubElement(suite, "testcase", name=name, classname="qvac", time=time_s)
                    ET.SubElement(tc, "failure", message="Test failed")
                    failed += 1

            elif status == "ERROR":
                m = re.search(r"\u274c\s+(.+?)\s+failed:\s+(.*)", log_line)
                if m:
                    name = m.group(1)
                    error_msg = m.group(2).strip()
                    tc = ET.SubElement(suite, "testcase", name=name, classname="qvac")
                    ET.SubElement(tc, "error", message=error_msg)
                    failed += 1

suite.set("tests", str(passed + failed))
suite.set("failures", str(failed))
suite.set("errors", "0")

tree = ET.ElementTree(suite)
ET.indent(tree, space="  ")
tree.write(output_file, xml_declaration=True, encoding="UTF-8")

print(f"JUnit XML: {passed + failed} tests ({passed} passed, {failed} failed) -> {output_file}")
