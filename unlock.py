import sys
import time
import interception


def main():
    password = sys.stdin.read().strip()
    if not password:
        print("no password on stdin", file=sys.stderr)
        sys.exit(1)

    interception.auto_capture_devices(keyboard=True)

    time.sleep(0.4)
    interception.press("enter")
    time.sleep(0.8)

    interception.write(password)
    time.sleep(0.3)
    interception.press("enter")

    print("ok")


if __name__ == "__main__":
    main()
